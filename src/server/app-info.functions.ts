import { createServerFn } from '@tanstack/react-start'
import { getAppInfo } from './app-info'

/** Für das Testsystem-Banner und die Versionsanzeige für Admins. */
export const getAppInfoFn = createServerFn({ method: 'GET' }).handler(() => getAppInfo())
