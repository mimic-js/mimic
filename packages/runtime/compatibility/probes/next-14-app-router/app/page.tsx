import { Counter } from './counter';

export default function Home() {
  return (
    <main>
      <h1>Hello from Next.js</h1>
      <p>Rendered on the server at {new Date().toISOString().slice(0, 10)}.</p>
      <Counter />
    </main>
  );
}
