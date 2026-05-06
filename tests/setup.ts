// Jest 测试环境设置

// 设置测试环境变量
process.env.PG_HOST = 'localhost';
process.env.PG_PORT = '5432';
process.env.PG_DATABASE = 'opencode_memory_test';
process.env.PG_USER = 'opencode';
process.env.PG_PASSWORD = 'test';

// 全局测试超时
jest.setTimeout(10000);

// 清理函数
afterAll(async () => {
  // 清理工作
});