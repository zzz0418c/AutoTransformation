import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createLlm } from './llm.js';

const config = loadConfig();
const llm = createLlm(config);
const app = createApp({ config, llm });

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log('');
  console.log('  AutoTransformation');
  console.log(`  ${url}`);
  console.log(
    config.demo
      ? '  演示模式：没有配置 LLM_API_KEY，识别 / 翻译 / 词义都返回示例数据。'
      : `  文本模型 ${config.text.model} · 视觉模型 ${config.vision.model}`,
  );
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用，换一个 PORT 再启动。`);
    process.exit(1);
  }
  throw error;
});
