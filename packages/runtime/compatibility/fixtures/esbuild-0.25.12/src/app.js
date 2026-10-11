import { shared } from './shared.js';
import { pluginValue } from 'virtual:user-plugin';
export const appValue = 'APP_VALUE_BEFORE';
export const result = [shared, pluginValue, import('./lazy.js')];