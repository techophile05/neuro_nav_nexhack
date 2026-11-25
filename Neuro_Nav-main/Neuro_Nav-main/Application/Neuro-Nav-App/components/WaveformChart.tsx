import { useMemo, useState } from 'react';
import { LayoutChangeEvent, View, StyleSheet } from 'react-native';
import Svg, { Line, Polyline } from 'react-native-svg';

type Props = {
  data: Float32Array;
  stroke: string;
  glow: string;
  scale: number;
  height?: number;
};

export function WaveformChart({ data, stroke, glow, scale, height = 140 }: Props) {
  const [w, setW] = useState(320);

  const onLayout = (e: LayoutChangeEvent) => {
    setW(Math.max(1, Math.floor(e.nativeEvent.layout.width)));
  };

  const { d, glowD, midH } = useMemo(() => {
    const W = w;
    const H = height;
    const mid = H * 0.5;
    const n = data.length;
    if (n < 2) return { d: '', glowD: '', midH: mid };
    const amp = (H * 0.38) / Math.max(1e-6, scale);
    const pts: string[] = [];
    const glowPts: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (W - 1);
      const y = mid - data[i] * amp;
      pts.push(`${x},${y}`);
      glowPts.push(`${x},${y}`);
    }
    return { d: pts.join(' '), glowD: glowPts.join(' '), midH: mid };
  }, [data, w, height, scale]);

  return (
    <View style={[styles.wrap, { height }]} onLayout={onLayout}>
      <Svg width={w} height={height}>
        <Polyline points={glowD} fill="none" stroke={glow} strokeWidth={5} strokeOpacity={0.28} />
        <Polyline points={d} fill="none" stroke={stroke} strokeWidth={2} strokeOpacity={0.95} />
        <Line x1={0} y1={midH} x2={w} y2={midH} stroke="rgba(226,232,240,0.10)" strokeWidth={1} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: 'rgba(2,6,23,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
});
