import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { DesktopReceiver } from './components/DesktopReceiver';
import { MobileSender } from './components/MobileSender';
import { OfflineIndicator } from './components/PWAInstallButton';
import { useTheme } from './hooks/useTheme';
import type { AppRole } from './types/protocol';

interface InitialBootstrap {
  role: AppRole;
  pairing: { sessionId: string; token: string } | null;
}

function readInitialBootstrap(): InitialBootstrap {
  const params = new URLSearchParams(window.location.search);
  const modeParam = params.get('mode');
  const sessionParam = params.get('session');
  const tokenParam = params.get('token');

  const pairing =
    sessionParam && tokenParam
      ? {
          sessionId: sessionParam.trim().toUpperCase(),
          token: tokenParam.trim(),
        }
      : null;

  // Strip pairing token from the browser URL bar immediately after reading it
  if (pairing) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('session');
    cleanUrl.searchParams.delete('token');
    cleanUrl.searchParams.set('mode', 'mobile');
    window.history.replaceState({}, '', cleanUrl.toString());
  }

  if (modeParam === 'mobile' || pairing) {
    return { role: 'mobile', pairing };
  }
  if (modeParam === 'desktop') {
    return { role: 'desktop', pairing: null };
  }

  const isMobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const isNarrowScreen = window.innerWidth < 768;
  return {
    role: isMobileUa || isNarrowScreen ? 'mobile' : 'desktop',
    pairing: null,
  };
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [bootstrap] = useState<InitialBootstrap>(() => readInitialBootstrap());
  const [role, setRole] = useState<AppRole>(bootstrap.role);

  useEffect(() => {
    registerSW({ immediate: true });
  }, []);

  return (
    <>
      {role === 'desktop' ? (
        <DesktopReceiver
          theme={theme}
          onToggleTheme={toggleTheme}
          onSwitchToMobile={() => setRole('mobile')}
        />
      ) : (
        <MobileSender
          theme={theme}
          onToggleTheme={toggleTheme}
          onSwitchToDesktop={() => setRole('desktop')}
          initialPairing={bootstrap.pairing}
        />
      )}
      <OfflineIndicator />
    </>
  );
}
