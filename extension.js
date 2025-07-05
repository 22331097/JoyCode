// @ts-nocheck
const vscode = require('vscode');
const { activateCodeCompletion } = require('./src/codeCompletion');
const { activateCommentToCode } = require('./src/commentToCode');
const {activateTempArea} = require('./src/TempArea');
const { deactivateCodeCompletion } = require('./src/codeCompletion');
const { deactivateCommentToCode } = require('./src/commentToCode');
const {deleteCustomModel, editCustomModel} = require('./src/openaiClient');


async function activate(context) {
   context.subscriptions.push(
    vscode.commands.registerCommand('navicode.switchModel', async () => {
      const config = vscode.workspace.getConfiguration('navicode');
      const currentModel = config.get('selectedModel', 'deepseek-chat');

      // 默认模型列表
      const defaultModels = ['deepseek-chat', 'gpt-4', 'gpt-3.5', 'doubao'];

      // 获取用户自定义模型列表
      const customModels = config.get('customModels', []);
      const customModelNames = customModels.map((m) => m.modelName);

      // 合并去重
      const allModels = [...new Set([...defaultModels, ...customModelNames])];

      const selectedModel = await vscode.window.showQuickPick(allModels, {
        placeHolder: `当前模型: ${currentModel}`
      });

      if (selectedModel) {
        await config.update('selectedModel', selectedModel, true);
        vscode.window.showInformationMessage(` 已切换到模型: ${selectedModel}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('navicode.deleteCustomModel', deleteCustomModel),
    vscode.commands.registerCommand('navicode.editCustomModel', editCustomModel)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('navicode.viewCurrentModelInfo', async () => {
      const config = vscode.workspace.getConfiguration('navicode');
      const selectedModel = config.get('selectedModel');
      const customModels = config.get('customModels', []);

      // 默认模型
      const builtInModelConfigs = {
        'deepseek-chat': {
          baseURL: 'https://api.deepseek.com/beta',
          model: 'deepseek-chat'
        },
        'gpt-4': {
          baseURL: 'https://api.openai.com/v1',
          model: 'gpt-4.1'
        },
        'gpt-3.5': {
          baseURL: 'https://api.openai.com/v1',
          model: 'gpt-3.5-turbo'
        },
        'doubao': {
          baseURL: 'https://ark.cn-beijing.volces.com/api/v3/',
          model: 'doubao-seed-1.6-250615'
        }
      };

      let info = builtInModelConfigs[selectedModel];

      if (!info) {
        // 从自定义模型中查找
        info = customModels.find(m => m.modelName === selectedModel);
      }

      if (!info) {
        vscode.window.showErrorMessage(`未找到模型 ${selectedModel} 的配置`);
        return;
      }

      vscode.window.showInformationMessage(
        `模型名称：${selectedModel}
        模型地址：${info.baseURL}
        模型参数：${info.model}`
      );
    })
);


  context.subscriptions.push(
    vscode.commands.registerCommand('navicode.configureCustomModels', async () => {
      try {
        let customModel = {
          modelName: '',
          baseURL: '',
          apiKey: '',
          model: ''
        };

        const steps = [
          { label: '1. 设置模型名称', key: 'modelName', prompt: '请输入模型名称（唯一标识）' },
          { label: '2. 设置 API URL', key: 'baseURL', prompt: '请输入模型API的 Base URL' },
          { label: '3. 设置 API Key', key: 'apiKey', prompt: '请输入 API Key', password: true },
          { label: '4. 设置模型 ID', key: 'model', prompt: '请输入模型标识（model 名称）' }
        ];

        for (let step of steps) {
          const value = await vscode.window.showInputBox({
            prompt: step.prompt,
            ignoreFocusOut: true,
            password: step.password || false,
            validateInput: (text) => (text.trim() === '' ? '不能为空' : null)
          });

          if (value === undefined) {
            vscode.window.showWarningMessage('配置流程已取消');
            return;
          }

          customModel[step.key] = value.trim();
        }

        // 读取已有配置
        const config = vscode.workspace.getConfiguration('navicode');
        const currentModels = config.get('customModels', []);

        // 检查重名
        if (currentModels.some((m) => m.modelName === customModel.modelName)) {
          vscode.window.showErrorMessage(`模型名称 "${customModel.modelName}" 已存在，请换一个名称`);
          return;
        }

        currentModels.push(customModel);

        await config.update('customModels', currentModels, vscode.ConfigurationTarget.Global);
        await config.update('selectedModel', customModel.modelName, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(` 模型 "${customModel.modelName}" 添加成功，并已设为当前模型`);
      } catch (err) {
        vscode.window.showErrorMessage('配置模型时发生错误: ' + err.message);
      }
    })
  );


  activateTempArea(context);
  activateCodeCompletion(context);
  activateCommentToCode(context);
  const { default: ChatViewProvider } = await import('./src/aiChatCodeGen.mjs');
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'navicodeChatView',
      new ChatViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const disposable = vscode.commands.registerCommand("navicode.openChat", async () => {
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar', true);
  });
  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
