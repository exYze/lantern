import { useId } from "react";
import type { AvatarEyes, AvatarMouth, AvatarShape, AvatarSpec } from "../lib/types";

export const AVATAR_SHAPES: AvatarShape[] = ["circle", "squircle", "hexagon", "flower", "diamond", "shield"];
export const AVATAR_EYES: AvatarEyes[] = ["dots", "happy", "wink", "wide", "sleepy", "visor"];
export const AVATAR_MOUTHS: AvatarMouth[] = ["smile", "grin", "flat", "open", "tongue", "none"];
export const AVATAR_COLORS = ["#7C5CFF", "#0EA5E9", "#22C55E", "#F59E0B", "#EC4899", "#14B8A6", "#64748B", "#8B5CF6", "#F97316", "#06B6D4", "#10B981", "#A855F7", "#EF4444", "#84CC16"];

function mix(hex: string, target: number, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount) + target * amount);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

const FACE = "#1E1838";

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

function Eyes({ eyes }: { eyes: AvatarEyes }) {
  const s = { stroke: FACE, strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" };
  switch (eyes) {
    case "dots":
      return (
        <g fill={FACE}>
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
          <circle cx="37" cy="46" r="6" fill={FACE} />
          <path d="M56 47 H70" {...s} />
        </g>
      );
    case "wide":
      return (
        <g>
          <circle cx="37" cy="45" r="10" fill="#fff" />
          <circle cx="63" cy="45" r="10" fill="#fff" />
          <circle cx="39" cy="46" r="5" fill={FACE} />
          <circle cx="65" cy="46" r="5" fill={FACE} />
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
          <rect x="24" y="37" width="52" height="18" rx="9" fill={FACE} />
          <circle cx="38" cy="46" r="4" fill="#9EF0FF" />
          <circle cx="62" cy="46" r="4" fill="#9EF0FF" />
        </g>
      );
  }
}

function Mouth({ mouth }: { mouth: AvatarMouth }) {
  const s = { stroke: FACE, strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" };
  switch (mouth) {
    case "smile":
      return <path d="M39 63 Q50 73 61 63" {...s} />;
    case "grin":
      return <path d="M37 61 Q50 79 63 61 Z" fill={FACE} stroke={FACE} strokeWidth="3" strokeLinejoin="round" />;
    case "flat":
      return <path d="M41 66 H59" {...s} />;
    case "open":
      return <ellipse cx="50" cy="67" rx="7" ry="6" fill={FACE} />;
    case "tongue":
      return (
        <g>
          <path d="M37 61 Q50 79 63 61 Z" fill={FACE} stroke={FACE} strokeWidth="3" strokeLinejoin="round" />
          <ellipse cx="50" cy="70" rx="6" ry="4" fill="#FF7A9C" />
        </g>
      );
    case "none":
      return null;
  }
}

export function Avatar({ spec, size = 36, busy, className = "" }: { spec: AvatarSpec; size?: number; busy?: boolean; className?: string }) {
  // Unique per instance: a shared id would resolve to a gradient inside a hidden (display:none) copy.
  const id = `av${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span className={`avatar${busy ? " avatar-busy" : ""} ${className}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor={mix(spec.color, 255, 0.28)} />
            <stop offset="1" stopColor={spec.color} />
          </linearGradient>
        </defs>
        <Shape shape={spec.shape} fill={`url(#${id})`} />
        <ellipse cx="36" cy="24" rx="16" ry="8" fill="#fff" opacity="0.22" />
        <Eyes eyes={spec.eyes} />
        <Mouth mouth={spec.mouth} />
        {spec.mouth !== "none" && spec.eyes !== "visor" && (
          <g fill="#FF8FB1" opacity="0.45">
            <circle cx="27" cy="60" r="5" />
            <circle cx="73" cy="60" r="5" />
          </g>
        )}
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
