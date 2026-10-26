import type { ApplicationConfig } from '@angular/core';
import {
  DOCUMENT,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { DESKTOP } from './core/desktop';
import { EnvironmentStore } from './core/environment-store';
import { SettingsStore } from './core/settings-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAppInitializer(async () => {
      // Lets styles adapt to the platform, e.g. room for the macOS traffic lights.
      inject(DOCUMENT).documentElement.dataset['platform'] = inject(DESKTOP).platform;
      await Promise.all([inject(SettingsStore).load(), inject(EnvironmentStore).load()]);
    }),
  ],
};
