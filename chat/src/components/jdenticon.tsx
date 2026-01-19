import * as React from "react";
import jdenticon from "jdenticon";

export interface JdenticonProps extends Omit<
  React.SVGProps<SVGSVGElement>,
  "width" | "height"
> {
  /**
   * The value to generate an identicon for (e.g., a user ID, public key, etc.)
   */
  value: string;
  /**
   * Size of the identicon in pixels
   * @default 64
   */
  size?: number;
}

/**
 * A React component that renders a Jdenticon identicon.
 *
 * @example
 * ```tsx
 * <Jdenticon value="user@example.com" size={48} />
 * ```
 */
export function Jdenticon({ value, size = 64, ...svgProps }: JdenticonProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);

  React.useEffect(() => {
    if (svgRef.current) {
      jdenticon.updateSvg(svgRef.current, value, size);
    }
  }, [value, size]);

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      {...svgProps}
    />
  );
}
