import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

type Props = {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  output: string;
};

export function Terminal({ onInput, onResize, output }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm>(null);
  const lastOutput = useRef('');
  const inputHandler = useRef(onInput);
  const resizeHandler = useRef(onResize);
  inputHandler.current = onInput;
  resizeHandler.current = onResize;

  useEffect(() => {
    if (!container.current) return;

    const xterm = new XTerm({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: 'monospace',
      fontSize: 14,
      theme: {
        background: '#0a0a0a',
        foreground: '#f0f0f0',
        cursor: '#d19a2c',
        selectionBackground: '#46b8c466',
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container.current);
    terminal.current = xterm;

    if (output) {
      xterm.write(output);
      lastOutput.current = output;
    }

    const resize = () => {
      fit.fit();
      resizeHandler.current(xterm.cols, xterm.rows);
    };
    const input = xterm.onData((data) => inputHandler.current(data));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);

    return () => {
      input.dispose();
      observer.disconnect();
      terminal.current = null;
      xterm.dispose();
    };
  }, []);

  useEffect(() => {
    const xterm = terminal.current;
    if (!xterm || output === lastOutput.current) return;

    if (output.startsWith(lastOutput.current)) {
      xterm.write(output.slice(lastOutput.current.length));
    } else {
      xterm.clear();
      if (output) xterm.write(output);
    }
    lastOutput.current = output;
  }, [output]);

  return <div ref={container} style={style} />;
}

const style: CSSProperties = {
  flex: 1,
  width: '100%',
  height: '100%',
  minHeight: 0,
  backgroundColor: '#0a0a0a',
};
