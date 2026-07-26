import '@fontsource-variable/geist/wght.css';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
// Vite bundles the pinned @pierre/diffs highlighting worker as its own entry.
import DiffsHighlightWorker from '@pierre/diffs/worker/worker.js?worker';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

const workerFactory = () => new DiffsHighlightWorker();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory }}
      highlighterOptions={{
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        langs: [
          'typescript',
          'javascript',
          'tsx',
          'jsx',
          'json',
          'css',
          'html',
          'python',
          'rust',
          'go',
          'java',
          'c',
          'cpp',
          'shellscript',
          'yaml',
          'markdown',
          'toml',
          'sql',
          'ruby',
          'php',
          'swift',
          'kotlin',
        ],
      }}
    >
      <App />
    </WorkerPoolContextProvider>
  </StrictMode>,
);
