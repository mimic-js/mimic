import pc from 'picocolors';

export function render(input) {
  return `<main><h1>${pc.green(`Vite 6.4.3 SSR rendered ${input.name}`)}</h1></main>`;
}
