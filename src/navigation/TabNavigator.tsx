import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Home, Search, Library, CircleUserRound } from 'lucide-react-native';
import { COLORS } from '../constants/theme';

import { HomeStack } from './HomeStack';
import { SearchStack } from './SearchStack';
import ProfileScreen from '../screens/Profile';
import { LibraryStack } from './LibraryStack';

const Tab = createBottomTabNavigator();

export const TabNavigator = () => {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarBackground: () => <View style={styles.tabBarBackground} />,
        tabBarActiveTintColor: COLORS.accent.green,
        tabBarInactiveTintColor: COLORS.iconInactive,
        tabBarShowLabel: false, // Removed text labels
      }}
    >
      <Tab.Screen 
        name="HomeTab" 
        component={HomeStack} 
        options={{
          tabBarIcon: ({ color, focused }) => (
            <Home color={color} size={24} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tab.Screen 
        name="SearchTab" 
        component={SearchStack} 
        options={{
          tabBarIcon: ({ color, focused }) => (
            <Search color={color} size={24} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tab.Screen 
        name="LibraryTab" 
        component={LibraryStack} 
        options={{
          tabBarIcon: ({ color, focused }) => (
            <Library color={color} size={24} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tab.Screen
        name="ProfileTab"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, focused }) => (
            <CircleUserRound color={color} size={24} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  tabBarBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.surfaceRaised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.hairline,
  },
  tabBar: {
    position: 'absolute',
    borderTopWidth: 0,
    elevation: 0,
    backgroundColor: 'transparent',
    // Sleek, thinner height
    height: Platform.OS === 'ios' ? 80 : 60, 
    paddingBottom: Platform.OS === 'ios' ? 20 : 8,
    paddingTop: 8,
  },
});
