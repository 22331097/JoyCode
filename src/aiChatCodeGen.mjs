// @ts-nocheck
import path from 'path';
import * as vscode from 'vscode';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { OpenAI } from 'openai';
import { config } from 'dotenv';
config({ path: `${__dirname}/.env` });
// 设置环境变量以指定模型缓存路径
// process.env.TRANSFORMERS_CACHE = modelPath;
import { getOpenAIInstance, getSelectedModel, modelConfigs } from './openaiClient.js';
import { extractStructureSummary } from './tools.js';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import JavaScript from 'tree-sitter-javascript';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
// 注册命令

class ChatViewProvider {
  constructor(context) {
    this.context = context;
    this.chatHistoryPath = path.join(context.extensionPath, 'chatHistory.json');
    console.log('聊天记录文件路径:', this.chatHistoryPath);
    this.systemPromptPath = path.join(context.extensionPath, 'systemPrompt.json');
    this.chatTitle = '';
    // 初始化数据
    this.fileContent = '';
    this.filePath = '';
    this.contextFiles = [];
    this.allSessions = {}; // 用于存储所有会话
    this.chatHistory = [];
    this.sessionId = ''; // 初始化会话ID
    this.lastActiveEditor = vscode.window.activeTextEditor;
    this.aiRole = 'general';
    this.flaskEndpoint = '';
    this.flaskToken = '';
    this.deepseek = process.env.deepseek;
    this.doubao = process.env.doubao;
    this.model = 'deepseek-chat'; // 默认模型
    this.modelConfig = {
      'deepseek-chat': {
        baseURL: 'https://api.deepseek.com/beta',
        apiKey: this.deepseek,
        model: 'deepseek-chat',
      },
      'doubao': {
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3/',
        apiKey: this.doubao,
        model: 'doubao-seed-1.6-250615',
      },
    };
    this.openai = new OpenAI({
      baseURL: this.modelConfig['deepseek-chat'].baseURL,
      apiKey: this.modelConfig['deepseek-chat'].apiKey,
    });
    this.loadSystemPrompt();
    vscode.commands.registerCommand('chatCodeGen.selectHistorySession', async () => {
      if (!fs.existsSync(this.chatHistoryPath)) {
        vscode.window.showInformationMessage('没有保存的历史聊天记录。');
        return;
      }
      try {
        const fileContent = fs.readFileSync(this.chatHistoryPath, 'utf-8');
        const allSessions = JSON.parse(fileContent || '{}');
        const items = Object.entries(allSessions).map(([sessionId, session]) => ({
          label: session.title || `未命名会话 `,
          sessionId: sessionId,
          history: session.history,
          title: session.title,
          alwaysShow: true,
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: '选择一个历史会话标题',
          canPickMany: false,
        });
        if (selected) {
          // 弹出操作菜单
          const action = await vscode.window.showQuickPick([
            { label: '继续此会话', action: 'open' },
            { label: '删除此对话记录', action: 'delete' },
          ], { placeHolder: `对“${selected.label}”进行操作` });
          if (action && action.action === 'delete') {
            // 删除会话
            delete allSessions[selected.sessionId];
            fs.writeFileSync(this.chatHistoryPath, JSON.stringify(allSessions, null, 2), 'utf-8');
            vscode.window.showInformationMessage(`已删除会话“${selected.label}”`);
            // 递归刷新
            vscode.commands.executeCommand('chatCodeGen.selectHistorySession');
            return;
          } else if (action && action.action === 'open') {
            this.sessionId = selected.sessionId;
            this.chatTitle = selected.title;
            this.chatHistory = selected.history || [];
            if (this.webviewView) {
              this.webviewView.webview.postMessage({
                command: 'loadHistorySession',
                sessionId: selected.sessionId,
                title: selected.label,
                history: selected.history,
              });
            }
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage('加载聊天记录失败: ' + err.message);
      }
    });
    // 监听编辑器变化
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.updateActiveEditorInfo();
    });
     vscode.window.onDidChangeTextEditorSelection(e => {
      this.updateActiveEditorInfo();
    });

  }

  loadSystemPrompt() {
    try {
      if (fs.existsSync(this.systemPromptPath)) {
        this.systemPromptData = JSON.parse(fs.readFileSync(this.systemPromptPath, 'utf-8'));
      }
    } catch (e) {
      console.error('读取 systemPrompt.json 失败:', e);
    }
  }

  loadChatHistory() {
    try {
      if (fs.existsSync(this.chatHistoryPath)) {
        this.chatHistory = JSON.parse(fs.readFileSync(this.chatHistoryPath, 'utf-8'));
      }
    } catch (e) {
      this.chatHistory = [];
    }
  }

  generateSessionId() {
    const now = new Date();
    let newsessionId = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // 例：20240617115600
    console.log('生成新的会话ID', newsessionId);
    return newsessionId;
  }

  startNewSession() {
    console.log('开始新会话');
    this.sessionId = this.generateSessionId(); // 新会话ID
    this.chatHistory = []; // 清空当前会话内容
  }

  saveChatHistory() {
    console.log('保存一条聊天记录');
    console.log('当前聊天记录:', this.chatHistory);
    try {
      // 如果已经有历史文件，就读出来
      if (fs.existsSync(this.chatHistoryPath)) {
        const fileContent = fs.readFileSync(this.chatHistoryPath, 'utf-8');
        this.allSessions = JSON.parse(fileContent);
      }
      // 保存当前会话到对应的 sessionId 下
      this.allSessions[this.sessionId] = {
        title: this.chatTitle,
        history: this.chatHistory,
      };
      fs.writeFileSync(this.chatHistoryPath, JSON.stringify(this.allSessions, null, 2), 'utf-8');
    } catch (e) {
      console.error('保存聊天记录失败:', e);
    }
  }

  updateActiveEditorInfo() {
    const editor = vscode.window.activeTextEditor || this.lastActiveEditor;
    if (editor) {
      const document = editor.document;
      const totalLines = document.lineCount;
      const selection = editor.selection;
      const cursorLine = selection.active.line;
      const startLine = Math.max(0, cursorLine - 200);
      const endLine = Math.min(totalLines - 1, cursorLine + 200);
      let snippet = '';
      for (let i = startLine; i <= endLine; i++) {
        snippet += document.lineAt(i).text + '\n';
      }
      this.fileContent = snippet;
      this.filePath = document.uri.fsPath;
      const fileName = path.basename(this.filePath);
      const fileType = document.languageId;
      this.lastActiveEditor = editor;
      if (this.webviewView) {
        this.webviewView.webview.postMessage({
          command: 'fileInfo',
          fileName,
          fileType,
          filePath: this.filePath,
        });
      }
    } else {
      const documents = vscode.workspace.textDocuments;
      if (documents.length > 0) {
        const document = documents[0];
        // 默认取前 100 行
        let snippet = '';
        const maxLines = Math.min(100, document.lineCount);
        for (let i = 0; i < maxLines; i++) {
          snippet += document.lineAt(i).text + '\n';
        }
        this.fileContent = snippet;
        this.filePath = document.uri.fsPath;
      } else {
        this.fileContent = '当前没有活动的编辑器，无法读取文件内容。';
        this.filePath = '';
      }
    }
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };
    // 生成头像路径
    const userAvatarUri = webviewView.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'user.png')),
    );
    const aiAvatarUri = webviewView.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'ai.png')),
    );
    const robotImgUri = webviewView.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'robot-img.svg')),
    );
    // 读取 index.html
    const htmlPath = path.join(this.context.extensionPath, 'media', 'index.html');
    let htmlContent;
    try {
      htmlContent = fs.readFileSync(htmlPath, 'utf8');
      htmlContent = htmlContent.replace(/__ROBOT_IMG_URI__/g, robotImgUri);
    } catch (error) {
      console.error('无法读取 HTML 文件:', error);
      vscode.window.showErrorMessage('无法加载聊天窗口的 HTML 文件。');
      return;
    }
    // 将头像路径注入到 HTML 中
    webviewView.webview.html = `
      <script>
        const userAvatarUri = "${userAvatarUri}";
        const aiAvatarUri = "${aiAvatarUri}";
      </script>
      ${htmlContent}
    `;
    // 初始化编辑器信息
    this.updateActiveEditorInfo();
    this.startNewSession(); // 初始化会话
    // 处理前端消息
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'removeContextFile':
          this.contextFiles = this.contextFiles.filter(f => f.filePath !== message.filePath);
          webviewView.webview.postMessage({
            command: 'contextFiles',
            files: this.contextFiles,
          });
          break;
        case 'invokeCommand':
          vscode.commands.executeCommand(message.name);
          break;
        case 'insertCode':
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            editor.edit((editBuilder) => {
              editBuilder.insert(editor.selection.active, message.code);
            }).then((success) => {
              if (success) {
                vscode.window.showInformationMessage('代码已成功插入到光标位置！');
              } else {
                vscode.window.showErrorMessage('代码插入失败，请重试。');
              }
            });
          } else {
            vscode.window.showErrorMessage('当前没有活动的编辑器，无法插入代码。');
          }
          break;
        case 'copyCode':
          vscode.window.showInformationMessage('代码已成功复制到剪贴板！');
          break;
        case 'selectContextFile':
          const options = {
            canSelectMany: false,
            openLabel: '选择文件',
            filters: {
              'All Files': ['*'],
            },
          };
          const uris = await vscode.window.showOpenDialog(options);
          if (uris && uris.length > 0) {
            const fileUri = uris[0];
            const filePath = fileUri.fsPath;
            const fileName = path.basename(filePath);
            try {
              const fileContent = fs.readFileSync(filePath, 'utf-8');
              this.contextFiles.push({ fileName, filePath, fileContent });
              webviewView.webview.postMessage({
                command: 'contextFiles',
                files: this.contextFiles,
              });
            } catch (err) {
              vscode.window.showErrorMessage('读取文件失败: ' + err.message);
            }
          }
          break;
        case 'askAI':
          await this.handleAiRequest(message, webviewView);
          break;
        case 'importModel':
          await this.checkImportModel(message, webviewView);
          break;
        case 'changeModel':
          this.model = message.model || 'deepseek-chat';
          console.log('切换为模型:', this.model);
          break;
        case 'regenerate':
          await this.handleRegenerateRequest(message, webviewView);
          break;
        case 'newChatWindow':
          // 处理新建聊天窗口的逻辑
          this.startNewSession();
          this.chatTitle = '';
          // 通知前端清空消息
          webviewView.webview.postMessage({
            command: 'clearChat',
          });
          break;
        case 'openSystemPromptJson':
          const fileMap = {
            general: 'prompt_general.json',
            software: 'prompt_software.json',
            backend: 'prompt_backend.json',
            dbdesigner: 'prompt_dbdesigner.json',
            miniapp: 'prompt_miniapp.json',
            webdev: 'prompt_webdev.json',
          };
          const fileName = fileMap[this.aiRole] || 'prompt_general.json';
          const filePath = path.join(this.context.extensionPath, 'media', 'roles', fileName);
          // 用 VS Code API 打开文件
          vscode.workspace.openTextDocument(filePath).then(doc => {
            vscode.window.showTextDocument(doc, { preview: false });
          });
          break;
        case 'changeRole':
          this.aiRole = message.role || 'general';
          break;
      }
    });
  }

  async handleAiRequest(message, webviewView) {
    const userInput = message.text;
    this.model = message.model; // 获取当前模型
    // 根据当前 this.aiRole 读取对应的 JSON 文件内容
    const fileMap = {
      general: 'prompt_general.json',
      software: 'prompt_software.json',
      backend: 'prompt_backend.json',
      dbdesigner: 'prompt_dbdesigner.json',
      miniapp: 'prompt_miniapp.json',
      webdev: 'prompt_webdev.json',
    };
    const fileName = fileMap[this.aiRole] || 'prompt_general.json';
    const filePath = path.join(this.context.extensionPath, 'media', 'roles', fileName);

    let systemPrompt = '';
    try {
      if (fs.existsSync(filePath)) {
        // 直接用整个 JSON 内容作为 systemPrompt
        systemPrompt = fs.readFileSync(filePath, 'utf-8');
      } else {
        systemPrompt = '';
      }
    } catch (e) {
      systemPrompt = '';
    }

    if (!userInput || userInput.trim() === '') {
      webviewView.webview.postMessage({ command: "response", text: "输入不能为空，请重新输入。" });
      return;
    }

    this.chatHistory.push({
      role: 'user',
      content: String(userInput),
    });

    if (this.chatHistory.length > 50) {
      this.chatHistory = this.chatHistory.slice(-50);
    }
    this.saveChatHistory();

    // 1. 尝试从用户输入中提取函数名关键词（简单正则，支持 def xxx/调用xxx/xxx函数等）
    let funcName = '';
    const funcMatch = userInput.match(/(?:def\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(|([a-zA-Z_][a-zA-Z0-9_]*)\s*函数/);
    if (funcMatch) {
      funcName = funcMatch[1] || funcMatch[2] || '';
    }
    // 2. 多语言支持：遍历 contextFiles，查找并补充该函数体完整代码
    function getParserAndNodeTypes(fileName) {
      if (fileName.endsWith('.py')) {
        return { lang: Python, nodeTypes: ['function_definition'], nameField: 'name' };
      }
      if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) {
        return { lang: JavaScript, nodeTypes: ['function_declaration', 'method_definition', 'function', 'arrow_function'], nameField: 'name' };
      }
      if (fileName.endsWith('.c')) {
        return { lang: C, nodeTypes: ['function_definition'], nameField: 'declarator' };
      }
      if (fileName.endsWith('.cpp')) {
        return { lang: Cpp, nodeTypes: ['function_definition'], nameField: 'declarator' };
      }
      return null;
    }
    let funcBodies = '';
    if (funcName) {
      for (const f of this.contextFiles) {
        const info = getParserAndNodeTypes(f.fileName);
        if (!info) continue;
        try {
          const parser = new Parser();
          parser.setLanguage(info.lang);
          const tree = parser.parse(f.fileContent);
          for (const nodeType of info.nodeTypes) {
            const funcNodes = tree.rootNode.descendantsOfType(nodeType);
            for (const node of funcNodes) {
              let nameNode = null;
              if (info.nameField === 'name') {
                nameNode = node.childForFieldName('name');
              } else if (info.nameField === 'declarator') {
                // C/C++: declarator 里 identifier
                const decl = node.childForFieldName('declarator');
                if(!decl) continue; // 没有 declarator，跳过
                if (decl) {
                  const idNode = decl.descendantsOfType('identifier')[0];
                  if (!idNode) continue; // 没有函数名，跳过
                  if (idNode) nameNode = idNode;
                }
              }
              if (nameNode && nameNode.text.includes(funcName)) {
                const code = f.fileContent.slice(node.startIndex, node.endIndex);
                funcBodies += `\n【${f.fileName}中${funcName}函数体】\n${code}\n`;
              }
            }
          }
        } catch (e) {}
      }
    }
    // 准备上下文提示
    let contextPrompt = '';
    if (this.contextFiles.length > 0) {
      // 用 extractStructureSummary生成结构摘要
      const astSummaries = await Promise.all(this.contextFiles.map(async f => {
        try {
          return await extractStructureSummary(f.fileContent, f.fileName);
        } catch (e) {
          return `【${f.fileName}结构摘要失败】\n` + (f.fileContent?.slice(0, 500) || '');
        }
      }));
      contextPrompt = funcBodies + astSummaries.join('\n');
      console.log('生成的上下文提示:', contextPrompt);
    } else {
      contextPrompt = '当前没有可用的上下文代码文件，仅根据用户提问的问题回答';
    }

    try {
      const isFirstQuestion = this.chatHistory.length === 1 && this.chatHistory[0].role === 'user' && !this.chatTitle;
      let reply = '';
      let chatTitle = '';
      if (this.model === 'deepseek-chat') {
        console.log('使用 DeepSeek 模型进行请求');
        this.openai = new OpenAI({
          baseURL: this.modelConfig['deepseek-chat'].baseURL,
          apiKey: this.modelConfig['deepseek-chat'].apiKey,
        });
        if (isFirstQuestion) {
          // 让AI同时返回回答和标题
          const response = await this.openai.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: "system",
                content:
                  `你是deepseek代码助手，这是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}\n请先回答用户问题，然后用一句话总结本次对话主题，格式为：\n【标题】xxxx`,
              },
              ...this.chatHistory.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            ],
          });

          const fullReply = response.choices[0]?.message?.content || "AI 无法生成回复。";
          // 提取标题
          const match = fullReply.match(/【标题】(.+)/);
          if (match) {
            reply = fullReply.replace(/【标题】.+/, '').trim();
            chatTitle = match[1].trim();
          } else {
            reply = fullReply;
            chatTitle = userInput.slice(0, 20); // 兜底
          }
          this.chatTitle = chatTitle;
          // 通知前端显示标题
          webviewView.webview.postMessage({ command: "setChatTitle", title: chatTitle });
          this.allSessions[this.sessionId] = {
            title: this.chatTitle, // 只添加 title 字段
          };
        } else {
          // 普通回复
          const response = await this.openai.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: "system",
                content:
                  `你是deepseek代码助手，这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}下面是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n`,
              },
              ...this.chatHistory.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            ],
          });
          reply = response.choices[0]?.message?.content || "AI 无法生成回复。";
        }
      } else if (this.model === 'doubao') {
        console.log('使用 Doubao 模型进行请求');
        this.openai = new OpenAI({
          baseURL: this.modelConfig['doubao'].baseURL,
          apiKey: this.modelConfig['doubao'].apiKey,
        });
        if (isFirstQuestion) {
          const historyText = this.chatHistory.map(msg => {
            return `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`;
          }).join('\n');
          // 让AI同时返回回答和标题
          const messages = [
            {
              role: "system",
              content: `你是豆包代码助手，这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}，下面是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n这是历史聊天记录：\n${historyText}\n请根据以上依据回答用户问题，并用一句话总结本次对话主题，格式为：\n【标题】xxxx`,
            },
            {
              role: "user",
              content: userInput,
            },
          ];

          const response = await this.openai.chat.completions.create({
            model: 'doubao-seed-1.6-250615',
            messages: messages,
          });

          const fullReply = response.choices[0]?.message?.content || "豆包模型无法生成回复。";
          // 提取标题
          const match = fullReply.match(/【标题】(.+)/);
          if (match) {
            reply = fullReply.replace(/【标题】.+/, '').trim();
            chatTitle = match[1].trim();
          } else {
            reply = fullReply;
            chatTitle = userInput.slice(0, 20); // 兜底
          }
          this.chatTitle = chatTitle;
          // 通知前端显示标题
          webviewView.webview.postMessage({ command: "setChatTitle", title: chatTitle });
          this.allSessions[this.sessionId] = {
            title: this.chatTitle, // 只添加 title 字段
          };
        } else {
          // 普通回复
          const historyText = this.chatHistory.map(msg => {
            return `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`;
          }).join('\n');
          const messages = [
            {
              role: "system",
              content: `你是豆包代码助手，这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}下面是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n这是历史聊天记录：\n${historyText}\n请回答用户问题`,
            },
            {
              role: "user",
              content: userInput,
            },
          ];

          const response = await this.openai.chat.completions.create({
            model: 'doubao-seed-1.6-250615',
            messages: messages,
          });
          reply = response.choices[0]?.message?.content || "豆包模型无法生成回复。";
        }
      } else {
        // 准备请求数据
        const userInput = message.text || '';
        const requestBody = {
          user_input: userInput,
        };

        // 发起请求到 Flask 服务
        const response = await fetch(this.flaskEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.flaskToken ? { Authorization: this.flaskToken } : {}), // 如果有 Token，则添加到请求头
          },
          body: JSON.stringify(requestBody),
        });

        // 解析响应
        if (!response.ok) {
          throw new Error(`后端服务器返回错误状态码: ${response.status}`);
        }

        const responseData = await response.json();
        reply = responseData.response || '后端模型服务未返回有效回复！';
      }
      this.chatHistory.push({
        role: 'assistant',
        content: String(reply),
      });

      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-50);
      }
      this.saveChatHistory();

      webviewView.webview.postMessage({ command: "response", text: reply });
    } catch (error) {
      console.error("OpenAI 请求失败:", error);
      webviewView.webview.postMessage({ command: "response", text: "对不起，AI 无法生成回复。" });
    }
  }

  async checkImportModel(message, webviewView) {
    const { endpoint, token } = message;

    // 验证 Flask URL 是否存在
    if (!endpoint || !endpoint.trim()) {
      webviewView.webview.postMessage({
        command: 'response',
        text: 'Flask 服务的 URL 地址不能为空，请重新输入。',
      });
      return;
    }

    try {
      // 验证 URL 格式
      new URL(endpoint);
    } catch {
      vscode.window.showErrorMessage('请输入合法的 Flask 服务 URL 地址。');
    }

    // 保存 URL 和 Token
    this.flaskEndpoint = endpoint;
    this.flaskToken = token;

    // 向前端确认保存成功
    vscode.window.showInformationMessage('Flask 服务 URL 和 Token 已保存!');

    console.log('Flask 服务 URL:', this.flaskEndpoint);
    console.log('Flask 服务 Token:', this.flaskToken || '未提供');
  }

  async handleRegenerateRequest(message, webviewView) {
    const lastUserMsg = this.chatHistory.filter(m => m.role === 'user').slice(-1)[0];
    if (!lastUserMsg) return;
    // 准备提示词
    const fileMap = {
      general: 'prompt_general.json',
      software: 'prompt_software.json',
      backend: 'prompt_backend.json',
      dbdesigner: 'prompt_dbdesigner.json',
      miniapp: 'prompt_miniapp.json',
      webdev: 'prompt_webdev.json',
    };
    const fileName = fileMap[this.aiRole] || 'prompt_general.json';
    const filePath = path.join(this.context.extensionPath, 'media', 'roles', fileName);

    let systemPrompt = '';
    try {
      if (fs.existsSync(filePath)) {
        // 直接用整个 JSON 内容作为 systemPrompt
        systemPrompt = fs.readFileSync(filePath, 'utf-8');
      } else {
        systemPrompt = '';
      }
    } catch (e) {
      systemPrompt = '';
    }

    // 1. 尝试从用户输入中提取函数名关键词（简单正则，支持 def xxx/调用xxx/xxx函数等）
    let funcName = '';
    const funcMatch = lastUserMsg.content.match(/(?:def\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(|([a-zA-Z_][a-zA-Z0-9_]*)\s*函数/);
    if (funcMatch) {
      funcName = funcMatch[1] || funcMatch[2] || '';
    }
    // 2. 多语言支持：遍历 contextFiles，查找并补充该函数体完整代码
    function getParserAndNodeTypes(fileName) {
      if (fileName.endsWith('.py')) {
        return { lang: Python, nodeTypes: ['function_definition'], nameField: 'name' };
      }
      if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) {
        return { lang: JavaScript, nodeTypes: ['function_declaration', 'method_definition', 'function', 'arrow_function'], nameField: 'name' };
      }
      if (fileName.endsWith('.c')) {
        return { lang: C, nodeTypes: ['function_definition'], nameField: 'declarator' };
      }
      if (fileName.endsWith('.cpp')) {
        return { lang: Cpp, nodeTypes: ['function_definition'], nameField: 'declarator' };
      }
      return null;
    }
    let funcBodies = '';
    if (funcName) {
      for (const f of this.contextFiles) {
        const info = getParserAndNodeTypes(f.fileName);
        if (!info) continue;
        try {
          const parser = new Parser();
          parser.setLanguage(info.lang);
          const tree = parser.parse(f.fileContent);
          for (const nodeType of info.nodeTypes) {
            const funcNodes = tree.rootNode.descendantsOfType(nodeType);
            for (const node of funcNodes) {
              let nameNode = null;
              if (info.nameField === 'name') {
                nameNode = node.childForFieldName('name');
              } else if (info.nameField === 'declarator') {
                // C/C++: declarator 里 identifier
                const decl = node.childForFieldName('declarator');
                if(!decl) continue; // 没有 declarator，跳过
                if (decl) {
                  const idNode = decl.descendantsOfType('identifier')[0];
                  if (idNode) nameNode = idNode;
                  if(!idNode) continue; // 没有函数名，跳过
                }
              }
              if (nameNode && nameNode.text === funcName) {
                const code = f.fileContent.slice(node.startIndex, node.endIndex);
                funcBodies += `\n【${f.fileName}中${funcName}函数体】\n${code}\n`;
              }
            }
          }
        } catch (e) {}
      }
    }
    // 3. 结构摘要
    let contextPrompt = '';
    if (this.contextFiles.length > 0) {
      const astSummaries = await Promise.all(this.contextFiles.map(async f => {
        try {
          return await extractStructureSummary(f.fileContent, f.fileName);
        } catch (e) {
          return `【${f.fileName}结构摘要失败】\n` + (f.fileContent?.slice(0, 500) || '');
        }
      }));
      contextPrompt = funcBodies + astSummaries.join('\n');
      console.log('生成的上下文提示:', contextPrompt);
    } else {
      contextPrompt = '当前没有可用的上下文代码文件，仅根据用户提问的问题回答';
    }

    try {
      const isFirstQuestion = this.chatHistory.length === 1 && this.chatHistory[0].role === 'user' && !this.chatTitle;
      let reply = '';
      let chatTitle = '';
      if (this.model === 'deepseek-chat') {
        console.log('使用 DeepSeek 模型进行请求');
        this.openai = new OpenAI({
          baseURL: this.modelConfig['deepseek-chat'].baseURL,
          apiKey: this.modelConfig['deepseek-chat'].apiKey,
        });
        if (isFirstQuestion) {
          // 让AI同时返回回答和标题
          const response = await this.openai.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: "system",
                content:
                  `你是deepseek代码助手，这是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}\n请先回答用户问题，然后用一句话总结本次对话主题，格式为：\n【标题】xxxx`,
              },
              ...this.chatHistory.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            ],
          });

          const fullReply = response.choices[0]?.message?.content || "AI 无法生成回复。";
          // 提取标题
          const match = fullReply.match(/【标题】(.+)/);
          if (match) {
            reply = fullReply.replace(/【标题】.+/, '').trim();
            chatTitle = match[1].trim();
          } else {
            reply = fullReply;
            chatTitle = '新会话'; // 兜底
          }
          this.chatTitle = chatTitle;
          // 通知前端显示标题
          webviewView.webview.postMessage({ command: "setChatTitle", title: chatTitle });
          this.allSessions[this.sessionId] = {
            title: this.chatTitle, // 只添加 title 字段
          };
        } else {
          // 普通回复
          const response = await this.openai.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: "system",
                content:
                  `你是deepseek代码助手，这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}下面是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n`,
              },
              ...this.chatHistory.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            ],
          });
          reply = response.choices[0]?.message?.content || "AI 无法生成回复。";
        }
      } else if (this.model === 'doubao') {
        console.log('使用 Doubao 模型进行请求');
        this.openai = new OpenAI({
          baseURL: this.modelConfig['doubao'].baseURL,
          apiKey: this.modelConfig['doubao'].apiKey,
        });
        if (isFirstQuestion) {
          const historyText = this.chatHistory.map(msg => {
            return `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`;
          }).join('\n');
          // 让AI同时返回回答和标题
          const messages = [
            {
              role: "system",
              content: `你是豆包代码助手，这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}，下面是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n这是历史聊天记录：\n${historyText}\n请根据以上依据回答用户问题，并用一句话总结本次对话主题，格式为：\n【标题】xxxx`,
            },
            {
              role: "user",
              content: lastUserMsg.content,
            },
          ];

          const response = await this.openai.chat.completions.create({
            model: 'doubao-seed-1.6-250615',
            messages: messages,
          });

          const fullReply = response.choices[0]?.message?.content || "豆包模型无法生成回复。";
          // 提取标题
          const match = fullReply.match(/【标题】(.+)/);
          if (match) {
            reply = fullReply.replace(/【标题】.+/, '').trim();
            chatTitle = match[1].trim();
          } else {
            reply = fullReply;
            chatTitle = '新会话'; // 兜底
          }
          this.chatTitle = chatTitle;
          // 通知前端显示标题
          webviewView.webview.postMessage({ command: "setChatTitle", title: chatTitle });
          this.allSessions[this.sessionId] = {
            title: this.chatTitle, // 只添加 title 字段
          };
        } else {
          // 普通回复
          const historyText = this.chatHistory.map(msg => {
            return `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`;
          }).join('\n');
          const messages = [
            {
              role: "system",
              content: `你是豆包代码助手，这是用户提供的json格式提示词模板，请转换为自然语言并理解：${systemPrompt}下面是用户提供的关联上下文文件：${contextPrompt}\n当前文件路径: ${this.filePath}\n文件内容:\n${this.fileContent}\n这是历史聊天记录：\n${historyText}\n请回答用户问题`,
            },
            {
              role: "user",
              content: lastUserMsg.content,
            },
          ];

          const response = await this.openai.chat.completions.create({
            model: 'doubao-seed-1.6-250615',
            messages: messages,
          });
          reply = response.choices[0]?.message?.content || "豆包模型无法生成回复。";
        }
      } else {
        // 其他模型或服务的处理逻辑
      }
      const lastAiIdx = this.chatHistory.map(m => m.role).lastIndexOf('assistant');

      if (lastAiIdx !== -1) {
        this.chatHistory[lastAiIdx].content = reply;
      } else {
        this.chatHistory.push({ role: 'assistant', content: reply });
      }

      if (this.chatHistory.length > 50) {
        this.chatHistory = this.chatHistory.slice(-50);
      }
      this.saveChatHistory();

      webviewView.webview.postMessage({ command: "response", text: reply });
    } catch (error) {
      console.error("OpenAI 请求失败:", error);
      webviewView.webview.postMessage({ command: "response", text: "对不起，AI 无法生成回复。" });
    }
  }
}

export default ChatViewProvider;

