import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

export function App() {
  return (
    <main className="app-shell">
      <h1>Publish Relay</h1>
      <p>Scheduling infrastructure is ready.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('UI root element is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
