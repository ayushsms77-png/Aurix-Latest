import React from 'react';
import Svg, { Path } from 'react-native-svg';

type Props = { size?: number; color?: string; strokeWidth?: number };

/** Outlined play triangle (the "Video" button). Same drawing as the queue icon, without the plus. */
export function PlayOutlineIcon({ size = 24, color = '#fff', strokeWidth = 2 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6.5 4.8 V19.2 L18.2 12 Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
