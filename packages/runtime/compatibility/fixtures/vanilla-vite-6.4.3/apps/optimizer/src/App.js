import pc from 'picocolors';
const root = document.querySelector('#root');
if (root === null) throw new Error('Optimizer root is unavailable');
root.innerHTML = `<main><h1>${pc.green("Vite 6 optimizer initial generation")}</h1><p data-framework>Vite 6 dependency optimizer</p></main>`;