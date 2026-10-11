<script>
  import './workflow.css';
  const framework = 'Svelte 5.56.10';
  let count = 0;
</script>
<main class="workflow-card">
  <h1>Svelte Vite 8 HMR initial render</h1>
  <p data-framework>{framework}</p>
  <button type="button" onclick={() => count += 1}>Increment</button>
  <strong data-refresh-count>{count}</strong>
</main>