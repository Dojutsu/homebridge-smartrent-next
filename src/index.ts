import type { API } from 'homebridge';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  SmartRentPlatform,
} from './platform/smart-rent-platform.js';

export { SmartRentPlatform } from './platform/smart-rent-platform.js';

export default function register(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SmartRentPlatform);
}
