import 'package:flutter/widgets.dart';

class FileBrowser extends StatelessWidget {
  const FileBrowser({super.key, this.allowDestructiveFiles = false});

  final bool allowDestructiveFiles;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Files'),
        const SizedBox(height: 8),
        const Text(
          'Directory list, search, text read/write, upload, and Git badges appear here.',
        ),
        if (allowDestructiveFiles) const Text('Delete and rename are enabled.'),
      ],
    );
  }
}
