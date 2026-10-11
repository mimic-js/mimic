/**
 * The logo mark, linking back to the site from the playground. A full page
 * navigation, so that leaving the playground ends its container with the page.
 */
export function SiteMark() {
  return (
    <a className="site-mark" href="/" aria-label="Mimic home">
      <img src="/mimic-mark.svg" alt="" width={22} height={22} />
    </a>
  );
}
