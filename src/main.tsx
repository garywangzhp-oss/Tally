import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

// ⚠️ 最外层必须有错误边界：渲染异常一旦逃出去，React 会卸载整棵树 →
// 窗口变成全透明（进程活着但什么都看不见），用户只会说「程序打不开了」。
createRoot(el).render(
  <StrictMode>
    <ErrorBoundary label="Tally">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
