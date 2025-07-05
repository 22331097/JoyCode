const { OpenAI } = require('openai');
const vscode = require('vscode');
require('dotenv').config({ path: __dirname + '/.env' });

// 默认模型配置
const modelConfigs = {
  'deepseek-chat': {
    baseURL: 'https://api.deepseek.com/beta',
    apiKey: process.env.deepseek,
    model: 'deepseek-chat'
  },
  'gpt-4': {
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.openaikey,
    model: 'gpt-4.1'
  },
  'gpt-3.5': {
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.openaikey,
    model: 'gpt-3.5-turbo'
  },
  'doubao': {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3/',
    apiKey: process.env.doubao,
    model: 'doubao-seed-1.6-250615'
  }
};

function getSelectedModel() {
  const config = vscode.workspace.getConfiguration('navicode');
  return config.get('selectedModel', 'deepseek-chat');
}

function getCustomModels() {
  const config = vscode.workspace.getConfiguration('navicode');
  return config.get('customModels', []);
}

function getOpenAIInstance() {
  const config = vscode.workspace.getConfiguration('navicode');
  const selectedModel = getSelectedModel();

  if (modelConfigs[selectedModel]) {
    const modelConfig = modelConfigs[selectedModel];
    return new OpenAI({
      baseURL: modelConfig.baseURL,
      apiKey: modelConfig.apiKey,
      defaultHeaders: {
        'Content-Type': 'application/json'
      }
    });
  }

  // 支持用户自定义模型
  const customModels = getCustomModels();
  const customModel = customModels.find((m) => m.modelName === selectedModel);

  if (!customModel) {
    throw new Error(`未找到模型配置: ${selectedModel}`);
  }

  return new OpenAI({
    baseURL: customModel.baseURL,
    apiKey: customModel.apiKey,
    defaultHeaders: {
      'Content-Type': 'application/json'
    }
  });
}

async function deleteCustomModel() {
  const config = vscode.workspace.getConfiguration('navicode');
  let customModels = config.get('customModels', []);

  if (customModels.length === 0) {
    vscode.window.showInformationMessage('当前没有自定义模型');
    return;
  }

  const modelNames = customModels.map(m => m.modelName);
  const modelToDelete = await vscode.window.showQuickPick(modelNames, { placeHolder: '请选择要删除的模型' });

  if (!modelToDelete) return;

  const confirm = await vscode.window.showWarningMessage(
    `确定删除模型 "${modelToDelete}" 吗？此操作不可撤销！`,
    { modal: true },
    '删除'
  );

  if (confirm !== '删除') return;

  customModels = customModels.filter(m => m.modelName !== modelToDelete);
  await config.update('customModels', customModels, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(`模型 "${modelToDelete}" 已成功删除`);
}

async function editCustomModel() {
  const config = vscode.workspace.getConfiguration('navicode');
  let customModels = config.get('customModels', []);
  if (customModels.length === 0) {
    vscode.window.showInformationMessage('没有自定义模型可供修改');
    return;
  }

  const modelNames = customModels.map(m => m.modelName);
  const selectedModelName = await vscode.window.showQuickPick(modelNames, { placeHolder: '请选择要修改的模型' });
  if (!selectedModelName) return;

  let modelToEdit = customModels.find(m => m.modelName === selectedModelName);

  // 逐步修改字段
  const newModelName = await vscode.window.showInputBox({
    prompt: '模型名称',
    value: modelToEdit.modelName,
    ignoreFocusOut: true // 保持输入框在切换时不自动关闭
  });
  if (!newModelName) return;

  const newBaseURL = await vscode.window.showInputBox({
    prompt: '模型地址',
    value: modelToEdit.baseURL,
    ignoreFocusOut: true
  });
  if (!newBaseURL) return;

  const newApiKey = await vscode.window.showInputBox({
    prompt: 'API Key',
    value: modelToEdit.apiKey,
    ignoreFocusOut: true
  });
  if (!newApiKey) return;

  const newModelParam = await vscode.window.showInputBox({
    prompt: '模型参数',
    value: modelToEdit.model,
    ignoreFocusOut: true
  });
  if (!newModelParam) return;

  const updatedModel = {
    modelName: newModelName,
    baseURL: newBaseURL,
    apiKey: newApiKey,
    model: newModelParam
  };

  customModels = customModels.map(m => (m.modelName === selectedModelName ? updatedModel : m));
  await config.update('customModels', customModels, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`模型 ${newModelName} 修改成功`);
}

module.exports = {
  getOpenAIInstance,
  getSelectedModel,
  modelConfigs,
  deleteCustomModel,
  editCustomModel
};
