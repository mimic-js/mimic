import pc from 'picocolors';
const root = document.querySelector('#root');
if (root === null) throw new Error('Optimizer root is unavailable');
root.innerHTML = `<main><h1>${pc.green("Vite 8 optimizer initial generation")}</h1><p data-framework>Vite 8 dependency optimizer</p></main>`;