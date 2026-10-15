/**
 * Configuração e Tema Visual dos Gráficos (Chart.js)
 */

export function isLightTheme(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'light'
  );
}

export function getChartColors() {
  const light = isLightTheme();
  return {
    primary: light ? '#2563eb' : '#3b82f6',
    primaryBg: light ? 'rgba(37, 99, 235, 0.12)' : 'rgba(59, 130, 246, 0.12)',
    success: light ? '#16a34a' : '#10b981',
    danger: light ? '#dc2626' : '#ef4444',
    textSecondary: light ? '#475569' : '#94a3b8',
    textMuted: light ? '#64748b' : '#64748b',
    borderGrid: light ? '#e2e8f0' : '#1e2c47',
    whiteDashed: light ? '#0f172a' : '#ffffff',
    cdi: '#c084fc',
  };
}

export const chartTheme = getChartColors;
