export function Icon({
  name,
  className = '',
  size,
}: {
  name: string;
  className?: string;
  size?: number;
}) {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <span
      className={`icon ${className}`}
      style={{
        ...style,
        maskImage: `url(/icons/${name}.svg)`,
        WebkitMaskImage: `url(/icons/${name}.svg)`,
      }}
      aria-hidden="true"
    />
  );
}
