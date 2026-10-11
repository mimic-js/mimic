import { createSignal } from 'solid-js';
import Message from './Message.jsx';
import './workflow.css';
export default function App() {
  const [count, setCount] = createSignal(0);
  return (
    <main class="workflow-card">
      <Message />
      <p data-framework>Solid 1.9.15</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>Increment</button>
      <strong data-refresh-count>{count()}</strong>
    </main>
  );
}