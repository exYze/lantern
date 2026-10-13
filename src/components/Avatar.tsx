import { AVATAR_COLORS, AVATAR_EYES, AVATAR_MOUTHS, AVATAR_SHAPES } from "../lib/avatar";
import type { AvatarEyes, AvatarMouth, AvatarShape, AvatarSpec } from "../lib/types";

export { AVATAR_COLORS, AVATAR_EYES, AVATAR_MOUTHS, AVATAR_SHAPES };

const INK = "#191D1B";
const CHALK = "#F3F1EA";

/** Ink features on light paint, chalk-white on dark paint. */
function faceFor(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return INK;
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum < 0.16 ? CHALK : INK;
}

function Shape({ shape, fill }: { shape: AvatarShape; fill: string }) {
  switch (shape) {
    case "circle":
      return <circle cx="50" cy="50" r="46" fill={fill} />;
    case "squircle":
      return <rect x="5" y="5" width="90" height="90" rx="30" fill={fill} />;
    case "hexagon":
      return <path d="M50 6 L88 28 V72 L50 94 L12 72 V28 Z" fill={fill} stroke={fill} strokeWidth="8" strokeLinejoin="round" />;
    case "diamond":
      return <path d="M50 7 L93 50 L50 93 L7 50 Z" fill={fill} stroke={fill} strokeWidth="10" strokeLinejoin="round" />;
    case "shield":
      return <path d="M50 5 L89 17 V49 C89 74 71 89 50 96 C29 89 11 74 11 49 V17 Z" fill={fill} stroke={fill} strokeWidth="4" strokeLinejoin="round" />;
    case "flower":
      return (
        <g fill={fill}>
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4;
            return <circle key={i} cx={50 + Math.cos(a) * 30} cy={50 + Math.sin(a) * 30} r="17" />;
          })}
          <circle cx="50" cy="50" r="34" />
        </g>
      );
  }
}

function Eyes({ eyes, face }: { eyes: AvatarEyes; face: string }) {
  const s = { stroke: face, strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" };
  switch (eyes) {
    case "dots":
      return (
        <g fill={face}>
          <circle cx="37" cy="46" r="6" />
          <circle cx="63" cy="46" r="6" />
        </g>
      );
    case "happy":
      return (
        <g {...s}>
          <path d="M30 49 Q37 40 44 49" />
          <path d="M56 49 Q63 40 70 49" />
        </g>
      );
    case "wink":
      return (
        <g>
          <circle cx="37" cy="46" r="6" fill={face} />
          <path d="M56 47 H70" {...s} />
        </g>
      );
    case "wide":
      return (
        <g>
          <circle cx="37" cy="45" r="10" fill="#fff" />
          <circle cx="63" cy="45" r="10" fill="#fff" />
          <circle cx="39" cy="46" r="5" fill={INK} />
          <circle cx="65" cy="46" r="5" fill={INK} />
        </g>
      );
    case "sleepy":
      return (
        <g {...s}>
          <path d="M30 46 Q37 52 44 46" />
          <path d="M56 46 Q63 52 70 46" />
        </g>
      );
    case "visor":
      return (
        <g>
          <rect x="24" y="37" width="52" height="18" rx="9" fill={INK} />
          <circle cx="38" cy="46" r="4" fill="#F4DDAA" />
          <circle cx="62" cy="46" r="4" fill="#F4DDAA" />
        </g>
      );
  }
}

function Mouth({ mouth, face }: { mouth: AvatarMouth; face: string }) {
  const s = { stroke: face, strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" };
  switch (mouth) {
    case "smile":
      return <path d="M39 63 Q50 73 61 63" {...s} />;
    case "grin":
      return <path d="M37 61 Q50 79 63 61 Z" fill={face} stroke={face} strokeWidth="3" strokeLinejoin="round" />;
    case "flat":
      return <path d="M41 66 H59" {...s} />;
    case "open":
      return <ellipse cx="50" cy="67" rx="7" ry="6" fill={face} />;
    case "tongue":
      return (
        <g>
          <path d="M37 61 Q50 79 63 61 Z" fill={face} stroke={face} strokeWidth="3" strokeLinejoin="round" />
          <ellipse cx="50" cy="70" rx="6" ry="4" fill="#D9705A" />
        </g>
      );
    case "none":
      return null;
  }
}

export function Avatar({ spec, size = 36, busy, className = "" }: { spec: AvatarSpec; size?: number; busy?: boolean; className?: string }) {
  return (
    <span className={`avatar${busy ? " avatar-busy" : ""} ${className}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <Shape shape={spec.shape} fill={spec.color} />
        <Eyes eyes={spec.eyes} face={faceFor(spec.color)} />
        <Mouth mouth={spec.mouth} face={faceFor(spec.color)} />
        {spec.badge && (
          <g>
            <circle cx="80" cy="20" r="17" fill="var(--bg-elevated, #fff)" />
            <text x="80" y="21" fontSize="20" textAnchor="middle" dominantBaseline="central">
              {spec.badge}
            </text>
          </g>
        )}
      </svg>
    </span>
  );
}

export function randomAvatar(): AvatarSpec {
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  return { shape: pick(AVATAR_SHAPES), color: pick(AVATAR_COLORS), eyes: pick(AVATAR_EYES), mouth: pick(AVATAR_MOUTHS.filter((m) => m !== "none")) };
}
