import { useState } from 'react';
import './workflow.css';
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="workflow-card">
      <h1>React Fast Refresh initial render</h1>
      <p data-framework>React 18.3.1</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>Increment</button>
      <strong data-refresh-count>{count}</strong>
    </main>
  );
}