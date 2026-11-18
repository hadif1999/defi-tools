// Loads TradingView's Lightweight Charts (served by the dashboard from node_modules) once, on first use.
let loading;
export function chartLibrary() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/lightweight-charts.js';
    script.onload = () => resolve(window.LightweightCharts);
    script.onerror = () => { loading = undefined; reject(new Error('The chart library could not be loaded.')); };
    document.head.append(script);
  });
  return loading;
}
