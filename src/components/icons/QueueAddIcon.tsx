import React from 'react';
import Svg, { Path } from 'react-native-svg';

type Props = { size?: number; color?: string; strokeWidth?: number };

/** Outlined play triangle with a plus: "add to queue". Same stroke style as the lucide icons. */
export function QueueAddIcon({ size = 24, color = '#fff', strokeWidth = 2 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 4.8 V17.2 L16.4 11 Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M18.4 15.2 V21.2 M15.4 18.2 H21.4"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}
