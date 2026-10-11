import pc from 'picocolors';
import './workflow.css';
document.querySelector('#root').innerHTML = `<main class="workflow-card"><h1>${pc.green("Vanilla Vite compatibility receipt")}</h1><p data-framework>Vanilla JavaScript</p><button type="button" data-workflow-increment>Increment state</button><output data-workflow-state>0</output></main>`;
document.querySelector('[data-workflow-increment]').addEventListener('click', () => {
  const state = document.querySelector('[data-workflow-state]');
  state.textContent = String(Number(state.textContent) + 1);
});
if (import.meta.hot) import.meta.hot.accept();