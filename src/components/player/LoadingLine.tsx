import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { COLORS } from '../../constants/theme';

/** A thin accent-red line that keeps sweeping from left to right while something loads. */
export function LoadingLine({ height = 3 }: { height?: number }) {
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!width) return;
    x.setValue(0);
    const loop = Animated.loop(
      Animated.timing(x, {
        toValue: 1,
        duration: 1300,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [width, x]);

  const bar = width * 0.4;
  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-bar, width] });

  return (
    <View style={[styles.track, { height }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Animated.View style={[styles.bar, { width: bar, height, transform: [{ translateX }] }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden', backgroundColor: 'transparent' },
  bar: { backgroundColor: COLORS.accent.green, borderRadius: 2 },
});
