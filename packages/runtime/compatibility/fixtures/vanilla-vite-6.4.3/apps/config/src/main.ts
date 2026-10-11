import pc from 'picocolors';
import resource from './resource.json';
import importedResourceUrl from './imported-resource.svg';

declare const __CONFIG_HEADING__: string;
type ResourcePayload = Readonly<{ marker: string }>;

const root = document.querySelector<HTMLElement>('#root');
if (root === null) throw new Error('Resource pipeline root is unavailable');
const payload: ResourcePayload = resource;
root.innerHTML = `
  <main>
    <h1>${pc.green(__CONFIG_HEADING__)}: ${payload.marker}: ${import.meta.env.VITE_RESOURCE_MARKER}</h1>
    <p data-framework>Vite 6 config and resource pipeline</p>
    <img alt="Imported resource" src="${importedResourceUrl}">
    <img alt="Public resource" src="/public-resource.svg">
  </main>
`;