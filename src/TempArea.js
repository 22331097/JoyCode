const { getOpenAIInstance, getSelectedModel ,modelConfigs} = require('./openaiClient');
const vscode = require('vscode');

let tempAreaContent = '';
let tempAreaPanel = null;


function getModelConfig() {
  const config = vscode.workspace.getConfiguration('navicode');
  const selectedModel = getSelectedModel();

  // 查找内置模型
  if (modelConfigs[selectedModel]) {
    return modelConfigs[selectedModel];
  }

  // 查找自定义模型
  const customModels = config.get('customModels', []);
  const customModel = customModels.find(m => m.modelName === selectedModel);
  if (customModel) {
    return customModel;
  }

  return null;
}

function addToTempArea(selectedText) {
  tempAreaContent += selectedText + '\n';
  if (tempAreaPanel) {
    tempAreaPanel.webview.html = getTempAreaHtml(tempAreaContent);
    registerMessageListener(tempAreaPanel); // 注册通信
  }
}

function showTempAreaPanel() {
  if (tempAreaPanel) {
    tempAreaPanel.reveal(vscode.ViewColumn.Beside);
    tempAreaPanel.webview.html = getTempAreaHtml(tempAreaContent);
    registerMessageListener(tempAreaPanel);
    return;
  }
  tempAreaPanel = vscode.window.createWebviewPanel(
    'tempAreaPanel',
    '临时记忆区',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
    }
  );
  tempAreaPanel.webview.html = getTempAreaHtml(tempAreaContent);
  registerMessageListener(tempAreaPanel);
  tempAreaPanel.onDidDispose(() => {
    tempAreaPanel = null;
  });
}

function registerMessageListener(panel) {
  panel.webview.onDidReceiveMessage((message) => {
    if (message.type === 'saveContent') {
      tempAreaContent = message.text || '';
      vscode.window.showInformationMessage('临时记忆区内容变更已保存 ');
    }
  });
}

function getTempAreaHtml(content) {
  return `
    <!DOCTYPE html>
    <html lang="zh">
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f4f4f4;
          padding: 20px;
          color: #333;
        }
        h3 {
          color: #0066cc;
          margin-bottom: 10px;
        }
        textarea {
          width: 100%;
          height: 700px;
          padding: 12px;
          font-size: 14px;
          border: 1px solid #ccc;
          border-radius: 6px;
          background-color: #fff;
          resize: vertical;
          white-space: pre;
          font-family: 'Courier New', monospace;
          line-height: 1.5;
          box-shadow: 0 0 5px rgba(0,0,0,0.1);
        }
        button {
          margin-top: 10px;
          padding: 6px 12px;
          font-size: 14px;
          background-color: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        button:hover {
          background-color: #004b99;
        }
        .footer {
          margin-top: 12px;
          font-size: 12px;
          color: #888;
        }
      </style>
    </head>
    <body>
      <h3>🧠 临时记忆区</h3>
      <textarea id="codeArea">${content}</textarea><br/>
      <button onclick="saveContent()">💾 保存内容</button>
      <div class="footer">你可以在这里编辑上下文，然后点击“保存内容”来更新临时记忆区。</div>

      <script>
        const vscode = acquireVsCodeApi();
        function saveContent() {
          const updatedText = document.getElementById('codeArea').value;
          vscode.postMessage({ type: 'saveContent', text: updatedText });
        }
      </script>
    </body>
    </html>
  `;
}

function activateTempArea(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.addToTempArea', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selectedText = editor.document.getText(editor.selection);
        if (selectedText.trim()) {
          addToTempArea(selectedText);
          vscode.window.showInformationMessage('已加入临时记忆区');
        }
      }
    }),
    vscode.commands.registerCommand('extension.showTempArea', () => {
      showTempAreaPanel();
    }),
    vscode.commands.registerCommand('extension.codeFromTempArea', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim() && !tempAreaContent.trim()) {
          vscode.window.showErrorMessage('没有可用内容');
          return;
        }
        const prompt = `上下文信息：\n${tempAreaContent}\n\n当前内容：\n${selectedText}\n\n请根据这些信息生成代码，只输出代码本身。`;
        const openai = getOpenAIInstance();
        const modelConfig = getModelConfig();
        if (!modelConfig) {
          vscode.window.showErrorMessage(`未找到模型配置: ${getSelectedModel()}`);
          return;
        }
        const model = modelConfig.model;
        console.log('OpenAI实例 baseURL:', openai.baseURL);
        console.log('选中模型:', getSelectedModel());
        console.log('当前模型:', model);
        try {
          // const response = await openai.completions.create({
          //   model: model,
          //   prompt: prompt,
          //   max_tokens: 1500
          // });
          // const generatedCode = response.choices[0]?.text.trim();



          let response,generatedCode;
          
          if (!model) {
            response=openai.responses.create({
              model: model,
              input: prompt,
              store: true
            });
          generatedCode = response;
          }else{
            response = await openai.chat.completions.create({
              model: model,
              messages: [
                { role: 'system', content: `你是一个代码生成助手` },
                { role: 'user', content: prompt }
              ],
              max_tokens: 1500
            });
            generatedCode = response.choices[0]?.message?.content.trim();
          }

          if (generatedCode) {
            tempAreaContent = ''; // 清空内容
            if (tempAreaPanel) {
              tempAreaPanel.webview.html = getTempAreaHtml(generatedCode);
              registerMessageListener(tempAreaPanel);
            } else {
              showTempAreaPanel();
              tempAreaPanel.webview.html = getTempAreaHtml(generatedCode);
              registerMessageListener(tempAreaPanel);
            }
            vscode.window.showInformationMessage('代码已生成，请在可视化区域复制');
          }
        } catch (error) {
          vscode.window.showErrorMessage('生成代码失败，请检查 API 设置。');
        }
      }
    })
  );
}

module.exports = {
  activateTempArea,
  addToTempArea,
  showTempAreaPanel
};
