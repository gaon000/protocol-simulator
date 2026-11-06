import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceRoot } from './ui/WorkspaceRoot.tsx';
import './ui/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing application root');

createRoot(container).render(
  <StrictMode>
    <WorkspaceRoot />
  </StrictMode>,
);
