import pc from 'picocolors';
import { nanoid } from 'nanoid/non-secure';
const root = document.querySelector('#root');
if (root === null) throw new Error('Optimizer root is unavailable');
root.innerHTML = `<main><h1>${pc.green("Vite 7 optimizer late dependency rendered")}</h1><p data-framework>Vite 7 dependency optimizer</p><output data-late-dependency>${nanoid(8)}</output></main>`;