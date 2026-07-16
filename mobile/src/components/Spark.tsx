import Svg, { Path } from "react-native-svg";

/** Четырёхлучевая искра — графический акцент бренда. */
export function Spark({ size, color }: { size: number; color: string }) {
    const c = size / 2;
    // Контрольные точки у центра делают лучи вогнутыми
    const w = size * 0.14;
    const d = `M ${c} 0 C ${c} ${c - w}, ${c + w} ${c}, ${size} ${c} C ${c + w} ${c}, ${c} ${c + w}, ${c} ${size} C ${c} ${c + w}, ${c - w} ${c}, 0 ${c} C ${c - w} ${c}, ${c} ${c - w}, ${c} 0 Z`;
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Path d={d} fill={color} />
        </Svg>
    );
}
