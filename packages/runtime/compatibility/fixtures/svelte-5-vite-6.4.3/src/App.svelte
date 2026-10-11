<script>
  import './workflow.css';
  const framework = 'Svelte 5.37.3';
  let count = 0;
</script>
<main class="workflow-card">
  <h1>Svelte HMR initial render</h1>
  <p data-framework>{framework}</p>
  <button type="button" onclick={() => count += 1}>Increment</button>
  <strong data-refresh-count>{count}</strong>
</main>