import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type Ref,
  type PointerEvent,
  type KeyboardEvent,
} from 'react';

type Axis = 'vertical' | 'horizontal';
type Metrics = {
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  top: number;
  left: number;
  x: number;
  y: number;
};
const empty: Metrics = {
  width: 0,
  height: 0,
  scrollWidth: 0,
  scrollHeight: 0,
  top: 0,
  left: 0,
  x: 0,
  y: 0,
};

export function ScrollArea({
  as = 'div',
  label,
  className = '',
  children,
  ref,
  scrollable = true,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'aside';
  label: string;
  ref?: Ref<HTMLElement>;
  scrollable?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    axis: Axis;
    coordinate: number;
    offset: number;
  } | null>(null);
  const [metrics, setMetrics] = useState(empty);
  const id = useId();
  const measure = useCallback(() => {
    const node = viewport.current;
    if (!node) return;
    if (!scrollable) {
      node.scrollLeft = 0;
      node.scrollTop = 0;
    }
    const next = {
      width: node.clientWidth,
      height: node.clientHeight,
      scrollWidth: scrollable ? node.scrollWidth : node.clientWidth,
      scrollHeight: scrollable ? node.scrollHeight : node.clientHeight,
      top: node.scrollTop,
      left: node.scrollLeft,
      x: node.offsetLeft,
      y: node.offsetTop,
    };
    setMetrics((current) =>
      Object.keys(next).every(
        (key) => current[key as keyof Metrics] === next[key as keyof Metrics],
      )
        ? current
        : next,
    );
  }, [scrollable]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    const observe = () => {
      observer?.disconnect();
      observer?.observe(node);
      for (const child of node.children) observer?.observe(child);
      measure();
    };
    const changes = new MutationObserver(observe);
    changes.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.addEventListener('resize', measure);
    observe();
    return () => {
      observer?.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [children, measure]);

  const dimensions = useCallback(
    (axis: Axis) => {
      const length = axis === 'vertical' ? metrics.height : metrics.width;
      const total =
        axis === 'vertical' ? metrics.scrollHeight : metrics.scrollWidth;
      const max = Math.max(0, total - length);
      const thumb = Math.min(
        length,
        Math.max(24, (length * length) / total || 0),
      );
      const offset = axis === 'vertical' ? metrics.top : metrics.left;
      return {
        length,
        max,
        thumb,
        offset,
        travel: Math.max(0, length - thumb),
      };
    },
    [metrics],
  );
  const scroll = useCallback(
    (axis: Axis, offset: number, relative = false) => {
      const node = viewport.current;
      if (!node) return;
      const { max } = dimensions(axis);
      const current = axis === 'vertical' ? node.scrollTop : node.scrollLeft;
      const next = Math.min(
        max,
        Math.max(0, offset + (relative ? current : 0)),
      );
      if (axis === 'vertical') node.scrollTop = next;
      else node.scrollLeft = next;
      measure();
    },
    [dimensions, measure],
  );
  const start = useCallback(
    (event: PointerEvent<HTMLDivElement>, axis: Axis) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      const { offset, thumb, travel, max } = dimensions(axis);
      const coordinate = axis === 'vertical' ? event.clientY : event.clientX;
      const rect = event.currentTarget.getBoundingClientRect();
      const position =
        coordinate - (axis === 'vertical' ? rect.top : rect.left);
      const onThumb = (event.target as HTMLElement).classList.contains(
        'scroll-thumb',
      );
      const next = onThumb
        ? offset
        : Math.max(
            0,
            Math.min(max, ((position - thumb / 2) / (travel || 1)) * max),
          );
      scroll(axis, next);
      drag.current = { axis, coordinate, offset: next };
    },
    [dimensions, scroll],
  );
  const move = useCallback(
    (event: PointerEvent<HTMLDivElement>, axis: Axis) => {
      if (drag.current?.axis !== axis) return;
      const { travel, max } = dimensions(axis);
      const coordinate = axis === 'vertical' ? event.clientY : event.clientX;
      scroll(
        axis,
        drag.current.offset +
          ((coordinate - drag.current.coordinate) / (travel || 1)) * max,
      );
    },
    [dimensions, scroll],
  );
  const key = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, axis: Axis) => {
      const { offset, length, max } = dimensions(axis);
      const values: Record<string, number> = {
        Home: 0,
        End: max,
        PageUp: offset - length,
        PageDown: offset + length,
        [axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft']: offset - 40,
        [axis === 'vertical' ? 'ArrowDown' : 'ArrowRight']: offset + 40,
      };
      if (!(event.key in values)) return;
      event.preventDefault();
      event.stopPropagation();
      scroll(axis, values[event.key]);
    },
    [dimensions, scroll],
  );
  const stop = () => {
    drag.current = null;
  };
  const bars = (['vertical', 'horizontal'] as const).map((axis) => (
    <Scrollbar
      key={axis}
      axis={axis}
      label={label}
      id={id}
      metrics={metrics}
      geometry={dimensions(axis)}
      onStart={start}
      onMove={move}
      onEnd={stop}
      onKey={key}
      onScroll={scroll}
    />
  ));
  const Tag = as;
  return (
    <Tag
      {...props}
      ref={ref as Ref<HTMLDivElement>}
      className={`scroll-area ${className}`}
    >
      <div
        ref={viewport}
        id={id}
        className={`scroll-viewport${scrollable ? '' : ' is-static'}`}
        role="region"
        aria-label={label}
        tabIndex={
          metrics.scrollHeight > metrics.height + 1 ||
          metrics.scrollWidth > metrics.width + 1
            ? 0
            : undefined
        }
        onScroll={measure}
      >
        {children}
      </div>
      {bars}
    </Tag>
  );
}

function Scrollbar({
  axis,
  label,
  id,
  metrics,
  geometry,
  onStart,
  onMove,
  onEnd,
  onKey,
  onScroll,
}: {
  axis: Axis;
  label: string;
  id: string;
  metrics: Metrics;
  geometry: {
    max: number;
    offset: number;
    length: number;
    thumb: number;
    travel: number;
  };
  onStart: (event: PointerEvent<HTMLDivElement>, axis: Axis) => void;
  onMove: (event: PointerEvent<HTMLDivElement>, axis: Axis) => void;
  onEnd: () => void;
  onKey: (event: KeyboardEvent<HTMLDivElement>, axis: Axis) => void;
  onScroll: (axis: Axis, offset: number, relative?: boolean) => void;
}) {
  const { max, offset, length, thumb, travel } = geometry;
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta =
        axis === 'vertical' ? event.deltaY : event.deltaX || event.deltaY;
      onScroll(
        axis,
        delta *
          (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? length : 1),
        true,
      );
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [axis, length, max, onScroll]);
  if (max <= 1) return null;
  const position = Math.min(travel, (offset / max) * travel);
  return (
    <div
      ref={track}
      className={'scrollbar scrollbar-' + axis}
      role="scrollbar"
      aria-label={label + (axis === 'vertical' ? '垂直' : '水平') + '滚动条'}
      aria-orientation={axis}
      aria-controls={id}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(offset)}
      tabIndex={0}
      style={
        axis === 'vertical'
          ? { top: metrics.y, height: length }
          : { left: metrics.x, width: length }
      }
      onPointerDown={(event) => onStart(event, axis)}
      onPointerMove={(event) => onMove(event, axis)}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
      onLostPointerCapture={onEnd}
      onKeyDown={(event) => onKey(event, axis)}
    >
      <span
        className="scroll-thumb"
        style={
          axis === 'vertical'
            ? { top: position, height: thumb }
            : { left: position, width: thumb }
        }
      />
    </div>
  );
}
