package fs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	iofs "io/fs"
	"mime/multipart"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
)

var (
	ErrDestructiveDisabled = errors.New("destructive filesystem actions disabled")
	ErrDestinationExists   = errors.New("destination exists")
)

type Service struct {
	WorkspaceRoot         string
	UploadRoot            string
	AllowDestructiveFiles bool
}

func NewService(workspaceRoot, uploadRoot string, allowDestructive bool) (*Service, error) {
	workspaceAbs, err := filepath.Abs(workspaceRoot)
	if err != nil {
		return nil, err
	}
	uploadAbs, err := filepath.Abs(uploadRoot)
	if err != nil {
		return nil, err
	}
	return &Service{WorkspaceRoot: workspaceAbs, UploadRoot: uploadAbs, AllowDestructiveFiles: allowDestructive}, nil
}

func (s *Service) Resolve(rel string) (string, string, bool, error) {
	cleaned := filepath.Clean(filepath.FromSlash(rel))
	if filepath.IsAbs(cleaned) {
		abs, err := filepath.Abs(cleaned)
		if err != nil {
			return "", "", false, err
		}
		return abs, filepath.ToSlash(abs), true, nil
	}
	abs, err := filepath.Abs(filepath.Join(s.WorkspaceRoot, cleaned))
	if err != nil {
		return "", "", false, err
	}
	if abs != s.WorkspaceRoot && !strings.HasPrefix(abs, s.WorkspaceRoot+string(filepath.Separator)) {
		return "", "", false, errors.New("path escapes workspaceRoot")
	}
	relPath, err := filepath.Rel(s.WorkspaceRoot, abs)
	if err != nil {
		return "", "", false, err
	}
	display := filepath.ToSlash(relPath)
	if display == "." {
		display = ""
	}
	return abs, display, false, nil
}

func (s *Service) List(rel string) ([]protocol.FileEntry, error) {
	abs, display, _, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := make([]protocol.FileEntry, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		childPath := filepath.ToSlash(filepath.Join(display, entry.Name()))
		if display == "/" {
			childPath = "/" + entry.Name()
		}
		out = append(out, protocol.FileEntry{Name: entry.Name(), Path: childPath, IsDir: entry.IsDir(), Size: info.Size(), Mode: info.Mode().String()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Service) Search(rel, query string) ([]protocol.FileEntry, error) {
	abs, _, absolute, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(query)
	out := make([]protocol.FileEntry, 0, 32)
	err = filepath.WalkDir(abs, func(path string, d iofs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == abs {
			return nil
		}
		if len(out) >= 200 {
			return io.EOF
		}
		if strings.Contains(strings.ToLower(d.Name()), query) {
			info, err := d.Info()
			if err != nil {
				return err
			}
			relPath, err := filepath.Rel(s.WorkspaceRoot, path)
			if absolute {
				relPath, err = filepath.Abs(path)
			}
			if err != nil {
				return err
			}
			out = append(out, protocol.FileEntry{Name: d.Name(), Path: filepath.ToSlash(relPath), IsDir: d.IsDir(), Size: info.Size(), Mode: info.Mode().String()})
		}
		return nil
	})
	if errors.Is(err, io.EOF) {
		return out, nil
	}
	return out, err
}

func (s *Service) ReadText(rel string) (*protocol.ReadFileResponse, error) {
	abs, safeRel, _, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.Size() > 1<<20 {
		return nil, errors.New("file exceeds 1 MiB")
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, errors.New("file is not valid UTF-8")
	}
	return &protocol.ReadFileResponse{Path: safeRel, Text: string(data), SHA256: sha256Text(data)}, nil
}

func (s *Service) WriteText(rel, content, expectedSHA256 string) (*protocol.ReadFileResponse, error) {
	abs, safeRel, _, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if info, err := os.Lstat(abs); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("symlink writes are not allowed")
	}
	current := ""
	if data, err := os.ReadFile(abs); err == nil {
		current = sha256Text(data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if current != expectedSHA256 {
		return nil, errors.New("sha256 mismatch")
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	data := []byte(content)
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return nil, err
	}
	return &protocol.ReadFileResponse{Path: safeRel, Text: content, SHA256: sha256Text(data)}, nil
}

func (s *Service) Delete(rel string) error {
	if !s.AllowDestructiveFiles {
		return ErrDestructiveDisabled
	}
	abs, _, _, err := s.Resolve(rel)
	if err != nil {
		return err
	}
	return os.RemoveAll(abs)
}

func (s *Service) Rename(oldRel, newRel string) error {
	if !s.AllowDestructiveFiles {
		return ErrDestructiveDisabled
	}
	oldAbs, _, _, err := s.Resolve(oldRel)
	if err != nil {
		return err
	}
	newAbs, _, _, err := s.Resolve(newRel)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(newAbs); err == nil {
		return ErrDestinationExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(oldAbs, newAbs)
}

func (s *Service) Copy(oldRel, newRel string) error {
	oldAbs, _, _, err := s.Resolve(oldRel)
	if err != nil {
		return err
	}
	newAbs, _, _, err := s.Resolve(newRel)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(newAbs); err == nil {
		return ErrDestinationExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	info, err := os.Lstat(oldAbs)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("symlink copy is not allowed")
	}
	if info.Mode().IsRegular() {
		return copyFile(oldAbs, newAbs, info.Mode().Perm())
	}
	if info.IsDir() {
		return filepath.WalkDir(oldAbs, func(path string, d iofs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, err := filepath.Rel(oldAbs, path)
			if err != nil {
				return err
			}
			target := filepath.Join(newAbs, rel)
			info, err := d.Info()
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("symlink copy is not allowed")
			}
			if d.IsDir() {
				return os.MkdirAll(target, info.Mode().Perm())
			}
			if info.Mode().IsRegular() {
				return copyFile(path, target, info.Mode().Perm())
			}
			return errors.New("unsupported file type")
		})
	}
	return errors.New("unsupported file type")
}

func (s *Service) OpenDownload(rel string) (*os.File, os.FileInfo, string, error) {
	abs, _, _, err := s.Resolve(rel)
	if err != nil {
		return nil, nil, "", err
	}
	file, err := os.Open(abs)
	if err != nil {
		return nil, nil, "", err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, "", err
	}
	if info.IsDir() {
		file.Close()
		return nil, nil, "", errors.New("path is a directory")
	}
	return file, info, filepath.Base(abs), nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func (s *Service) Upload(relDir string, file multipart.File, header *multipart.FileHeader) (string, error) {
	targetRoot, _, err := s.resolveUpload(relDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(targetRoot, filepath.Base(header.Filename))
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	defer out.Close()
	if _, err := io.Copy(out, io.LimitReader(file, 50<<20)); err != nil {
		return "", err
	}
	relPath, err := filepath.Rel(s.WorkspaceRoot, target)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(relPath), nil
}

func (s *Service) GitStatus(rel string) protocol.GitStatusResponse {
	abs, _, _, err := s.Resolve(rel)
	if err != nil {
		return protocol.GitStatusResponse{Available: false, Entries: nil}
	}
	if _, err := exec.LookPath("git"); err != nil {
		return protocol.GitStatusResponse{Available: false, Entries: []protocol.GitEntry{}}
	}
	cmd := exec.Command("git", "-C", abs, "status", "--short", "--", rel)
	out, err := cmd.Output()
	if err != nil {
		return protocol.GitStatusResponse{Available: false, Entries: []protocol.GitEntry{}}
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	entries := make([]protocol.GitEntry, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" || len(line) < 4 {
			continue
		}
		entries = append(entries, protocol.GitEntry{Code: strings.TrimSpace(line[:2]), Path: strings.TrimSpace(line[3:])})
	}
	return protocol.GitStatusResponse{Available: true, Entries: entries}
}

func (s *Service) resolveUpload(rel string) (string, string, error) {
	joined := filepath.Join(s.UploadRoot, filepath.Clean(rel))
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", "", err
	}
	if abs != s.UploadRoot && !strings.HasPrefix(abs, s.UploadRoot+string(filepath.Separator)) {
		return "", "", errors.New("upload path escapes uploadRoot")
	}
	relPath, err := filepath.Rel(s.UploadRoot, abs)
	if err != nil {
		return "", "", err
	}
	return abs, filepath.ToSlash(relPath), nil
}

func sha256Text(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
