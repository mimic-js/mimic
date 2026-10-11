import type { SimpleIcon } from 'simple-icons';

/** The chips' background (`--surface-raised`), which a brand colour must stand out from. */
const CHIP_BACKGROUND = '1c202b';

/** The contrast below which a brand colour is drawn in the chip's text colour instead. */
const MINIMUM_CONTRAST = 2.5;

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The brand colour, or `currentColor` for a brand too dark for the dark theme (Angular, Nx, Koa, …). */
function fill(hex: string): string {
  const contrast = (luminance(hex) + 0.05) / (luminance(CHIP_BACKGROUND) + 0.05);
  return contrast >= MINIMUM_CONTRAST ? `#${hex}` : 'currentColor';
}

/** A stack's logo, or a rounded square with its first letter for a stack Simple Icons has no logo for. */
export function StackIcon({ icon, label }: { readonly icon: SimpleIcon | undefined; readonly label: string }) {
  return (
    <svg className="stack-icon" viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" focusable="false">
      {icon ? (
        <path d={icon.path} fill={fill(icon.hex)} />
      ) : (
        <>
          <rect x={1.5} y={1.5} width={21} height={21} rx={5} fill="none" stroke="currentColor" strokeWidth={2} />
          <text x={12} y={16.5} textAnchor="middle" fontSize={13} fontWeight={700} fill="currentColor">
            {label.charAt(0).toUpperCase()}
          </text>
        </>
      )}
    </svg>
  );
}
