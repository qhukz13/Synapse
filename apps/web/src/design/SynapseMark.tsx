import type { SVGProps } from "react";

type SynapseMarkProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  size?: 16 | 24 | 32;
  label?: string;
};

export function SynapseMark({ size = 16, label, ...props }: SynapseMarkProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="var(--accent)"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <circle cx="3.5" cy="11.5" r="2.25" />
      <path d="M4.5 10.72L8.75 7.42" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="12.5" cy="4.5" r="2.25" />
    </svg>
  );
}
