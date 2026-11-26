import tseslint from 'typescript-eslint';

// ESLint flat config.
// Các quy tắc no-restricted-* dưới đây cưỡng chế hướng phụ thuộc:
// transports -> server -> tools -> cổng trong ctx <- services;
// core/ và utils/ ở dưới cùng, không import ngược.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // stdout dành cho kênh stdio của MCP; mọi log phải đi qua logger ghi stderr (thêm ở bước sau).
      'no-console': 'error',
    },
  },
  {
    // Tool chỉ làm việc qua ctx: không tự đọc môi trường, không tự gọi mạng, không biết transport.
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/transports', '**/transports/**'],
              message: 'Tool không được import từ transports/; hãy nhận transport qua ctx.',
            },
            {
              group: ['**/config/env', '**/config/env.js'],
              message: 'Tool không được đọc cấu hình trực tiếp; hãy nhận qua ctx.',
            },
            {
              group: ['**/services', '**/services/**'],
              message: 'Tool không được import từ services/; hãy nhận cổng qua ctx.',
            },
            {
              group: ['**/server', '**/server.js'],
              message: 'Tool không được import từ server; hãy đăng ký qua ToolRegistry.',
            },
            {
              group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/**'],
              message:
                'Chỉ server.ts và transports/ được import SDK MCP (@modelcontextprotocol/sdk).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Tool không được gọi mạng trực tiếp; hãy dùng cổng trong ctx (GhnClient).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Tool không được đọc process.env; hãy nhận qua ctx.',
        },
        {
          object: 'globalThis',
          property: 'fetch',
          message:
            'Tool không được gọi mạng trực tiếp qua globalThis.fetch; hãy dùng cổng trong ctx (GhnClient).',
        },
      ],
    },
  },
  {
    // core/ và utils/ là lớp dưới cùng, không được kéo lớp trên vào.
    files: ['src/core/**/*.ts', 'src/utils/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tools', '**/tools/**'],
              message: 'core/utils không được import từ tools/.',
            },
            {
              group: ['**/services', '**/services/**'],
              message: 'core/utils không được import từ services/.',
            },
            {
              group: ['**/transports', '**/transports/**'],
              message: 'core/utils không được import từ transports/.',
            },
            {
              group: ['**/server', '**/server.js'],
              message: 'core/utils không được import từ server.',
            },
            {
              group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/**'],
              message:
                'Chỉ server.ts và transports/ được import SDK MCP (@modelcontextprotocol/sdk).',
            },
          ],
        },
      ],
    },
  },
  {
    // config/ và services/ không được phụ thuộc SDK MCP: chỉ server.ts và transports/ được import.
    files: ['src/config/**/*.ts', 'src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/**'],
              message:
                'Chỉ server.ts và transports/ được import SDK MCP (@modelcontextprotocol/sdk).',
            },
          ],
        },
      ],
    },
  },
  {
    // Client GHN không được phụ thuộc SDK MCP.
    files: ['src/services/ghn-client.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/**'],
              message: 'ghn-client.ts không được import SDK MCP.',
            },
          ],
        },
      ],
    },
  },
);
