/**
 * Keeps a published document's navigations on its endpoint. The document is
 * served under its endpoint's path (`…/__mimic__/<instance>/<route>/<port>/`),
 * so a link, form or script that navigates to a root-relative URL such as
 * `/posts/first` would leave the endpoint for the embedding origin. Such a
 * navigation is sent to the same path under the endpoint instead, the way a
 * server at the root of its own origin would receive it.
 *
 * The function is serialized into the document runtime, so it uses nothing
 * outside its own body.
 */
export function installPublishedEndpointDocumentNavigationProgram(): void {
  type NavigationWindow = Window &
    typeof globalThis & {
      __mimicPublishedEndpointNavigation?: boolean;
      navigation?: EventTarget;
    };
  type NavigateEvent = Event & {
    readonly cancelable: boolean;
    readonly hashChange: boolean;
    readonly downloadRequest: string | null;
    readonly formData: FormData | null;
    readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
    readonly destination: { readonly url: string };
  };

  const documentWindow = window as NavigationWindow;
  if (documentWindow.__mimicPublishedEndpointNavigation) return;
  documentWindow.__mimicPublishedEndpointNavigation = true;

  const endpointPath = /^(.*?\/__mimic__\/[^/]+\/[^/]+\/\d+)(?:\/|$)/u.exec(
    documentWindow.location.pathname
  )?.[1];
  if (!endpointPath) return;
  const endpointsDirectory = endpointPath.slice(0, endpointPath.indexOf('/__mimic__/') + '/__mimic__/'.length);

  /** The URL under the endpoint for a same-origin URL that left it, or undefined for any other. */
  const onEndpoint = (target: string): string | undefined => {
    let url: URL;
    try {
      url = new URL(target, documentWindow.location.href);
    } catch {
      return undefined;
    }
    if (url.origin !== documentWindow.location.origin) return undefined;
    if (url.pathname === endpointPath || url.pathname.startsWith(`${endpointPath}/`)) return undefined;
    // Another endpoint of this container, or the worker's own files.
    if (url.pathname.startsWith(endpointsDirectory)) return undefined;
    return `${endpointPath}${url.pathname}${url.search}${url.hash}`;
  };

  documentWindow.navigation?.addEventListener('navigate', (event) => {
    const navigate = event as NavigateEvent;
    if (!navigate.cancelable || navigate.hashChange || navigate.downloadRequest !== null) return;
    if (navigate.navigationType === 'reload' || navigate.navigationType === 'traverse') return;
    // A form submission is rewritten where it starts, below, since its body
    // cannot be resent from here.
    if (navigate.formData) return;
    const destination = onEndpoint(navigate.destination.url);
    if (destination === undefined) return;
    event.preventDefault();
    if (navigate.navigationType === 'replace') documentWindow.location.replace(destination);
    else documentWindow.location.assign(destination);
  });

  documentWindow.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const submitter = (event as SubmitEvent).submitter;
      if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
        if (submitter.hasAttribute('formaction')) {
          const destination = onEndpoint(submitter.formAction);
          if (destination !== undefined) submitter.formAction = destination;
          return;
        }
      }
      const destination = onEndpoint(form.action);
      if (destination !== undefined) form.action = destination;
    },
    true
  );
}
