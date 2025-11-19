// script.js

class LLMTokenGenerator {
    constructor() {
        this.isGenerating = false;
        this.sessionId = Date.now().toString();
        this.currentTurn = 0;
        this.selectedModels = [];
        this.fullTextContent = ''; // 新增：存储完整的纯文字内容
        
        this.initEventListeners();
    }
    
    initEventListeners() {
        // 模型选择监听器
        document.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', () => this.updateSelectedModels());
        });
        
        // 按钮监听器
        document.getElementById('start-generation').addEventListener('click', () => this.startGeneration());
        document.getElementById('stop-generation').addEventListener('click', () => this.stopGeneration());
        document.getElementById('reset-conversation').addEventListener('click', () => this.resetConversation());
    }
    
    updateSelectedModels() {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]:checked');
        this.selectedModels = Array.from(checkboxes).map(checkbox => {
            const modelId = checkbox.id;
            const apiKeyInput = document.getElementById(`${modelId}-key`);
            return {
                modelName: checkbox.value,
                provider: checkbox.dataset.provider,
                apiKey: apiKeyInput ? apiKeyInput.value : '',
                displayName: checkbox.nextElementSibling.textContent
            };
        }).filter(model => model.apiKey.trim() !== '');
        
        console.log('Selected models:', this.selectedModels);
        this.updateStartButtonState();
    }
    
    updateStartButtonState() {
        const startBtn = document.getElementById('start-generation');
        const prompt = document.getElementById('user-prompt').value.trim();
        
        startBtn.disabled = this.selectedModels.length === 0 || !prompt || this.isGenerating;
    }
    
    async startGeneration() {
        const prompt = document.getElementById('user-prompt').value.trim();
        const tokensPerTurn = parseInt(document.getElementById('tokens-per-turn').value) || 5;
        const maxTurns = parseInt(document.getElementById('max-turns').value) || 50;
        
        if (this.selectedModels.length === 0) {
            alert('Please select at least one model and enter the corresponding API keys!');
            return;
        }
        
        if (!prompt) {
            alert('Please enter an initial prompt!');
            return;
        }
        
        this.isGenerating = true;
        this.currentTurn = 0;
        this.maxTurns = maxTurns;
        this.fullTextContent = prompt; // 初始化纯文字内容为初始提示
        this.updateUI();
        
        // 显示输出区域
        const outputSection = document.getElementById('output-section');
        const textOnlySection = document.getElementById('text-only-section');
        outputSection.style.display = 'block';
        textOnlySection.style.display = 'block';
        
        // Initialize conversation display
        const display = document.getElementById('conversation-display');
        display.innerHTML = `<div style="color: #666; margin-bottom: 20px; padding: 10px; background: #f0f0f0; border-radius: 6px;">
            <strong>Initial Prompt:</strong> ${prompt}<br>
            <strong>Max Turns:</strong> ${maxTurns} | <strong>Tokens per Turn:</strong> ${tokensPerTurn}
        </div>`;
        
        // Initialize text-only display
        const textOnlyDisplay = document.getElementById('text-only-display');
        textOnlyDisplay.textContent = this.fullTextContent;
        
        try {
            while (this.isGenerating && this.currentTurn < this.maxTurns) {
                const currentModelIndex = this.currentTurn % this.selectedModels.length;
                const currentModel = this.selectedModels[currentModelIndex];
                
                console.log(`Turn ${this.currentTurn}: Using model index ${currentModelIndex} (${currentModel.displayName}) out of ${this.selectedModels.length} models`);
                
                // Update status display
                this.updateStatus(`Turn ${this.currentTurn + 1}/${this.maxTurns} - Generating with ${currentModel.displayName}...`);
                
                // 发送请求到后端
                const response = await fetch('/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        sessionId: this.sessionId,
                        models: this.selectedModels,
                        prompt: prompt,
                        tokensPerTurn: tokensPerTurn
                    }),
                });
                
                if (!response.ok) {
                    let errorMessage;
                    const contentType = response.headers.get('content-type');
                    
                    if (contentType && contentType.includes('application/json')) {
                        const errorData = await response.json();
                        errorMessage = errorData.error || 'Request failed';
                    } else {
                        // If the response is not JSON, it might be an HTML error page
                        const errorText = await response.text();
                        errorMessage = `Server returned non-JSON response, possibly a server error. Status code: ${response.status}`;
                        console.error('Server returned HTML instead of JSON:', errorText.substring(0, 500));
                    }
                    
                    throw new Error(errorMessage);
                }
                
                let data;
                try {
                    data = await response.json();
                } catch (jsonError) {
                    console.error('Failed to parse JSON response:', jsonError);
                    const responseText = await response.text();
                    console.error('Raw response:', responseText.substring(0, 500));
                    throw new Error('Server returned invalid JSON response, possibly a server error');
                }
                
                if (this.isGenerating) {
                    // Use the turn number from the server response to ensure consistency
                    const serverTurn = data.sessionTurn !== undefined ? data.sessionTurn : this.currentTurn;
                    
                    this.displayModelResponse(data.reply, currentModel, serverTurn);
                    this.currentTurn++;
                    
                    console.log(`Completed turn ${serverTurn}, next will be turn ${this.currentTurn}`);
                    
                    // Update statistics
                    this.updateStats();
                    
                    // Check if we've reached the maximum turns
                    if (this.currentTurn >= this.maxTurns) {
                        this.updateStatus(`Completed all ${this.maxTurns} turns`);
                        this.stopGeneration();
                        break;
                    }
                    
                    // Brief delay to let user see the generation process
                    await this.sleep(500);
                }
            }
        } catch (error) {
            console.error('Generation error:', error);
            alert(`An error occurred during generation: ${error.message}`);
            this.stopGeneration();
        }
    }
    
    displayModelResponse(response, model, turn) {
        const display = document.getElementById('conversation-display');
        const modelClass = `model-${model.provider}`;
        
        const turnElement = document.createElement('span');
        turnElement.innerHTML = `<span class="model-turn">Turn ${turn + 1}</span><span class="${modelClass}">[${model.displayName}]:</span> ${response} `;
        
        display.appendChild(turnElement);
        display.scrollTop = display.scrollHeight;
        
        // 更新纯文字显示 - 只添加响应内容，不包括模型标识
        this.fullTextContent += ' ' + response;
        const textOnlyDisplay = document.getElementById('text-only-display');
        textOnlyDisplay.textContent = this.fullTextContent;
        textOnlyDisplay.scrollTop = textOnlyDisplay.scrollHeight;
    }
    
    updateStatus(message) {
        document.getElementById('current-status').textContent = message;
    }
    
    updateStats() {
        const statsElement = document.getElementById('generation-stats');
        statsElement.textContent = `Generated ${this.currentTurn}/${this.maxTurns || 50} rounds | Using ${this.selectedModels.length} models`;
    }
    
    stopGeneration() {
        this.isGenerating = false;
        this.updateStatus('Generation stopped');
        this.updateUI();
    }
    
    async resetConversation() {
        // Stop any ongoing generation first
        this.isGenerating = false;
        
        // Send reset request to backend
        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId: this.sessionId,
                    reset: true
                }),
            });
            
            if (response.ok) {
                console.log('Backend session reset successfully');
            }
        } catch (error) {
            console.error('Reset error:', error);
        }
        
        // Reset frontend state completely
        this.sessionId = Date.now().toString();
        this.currentTurn = 0;
        this.maxTurns = 50; // Reset to default
        this.isGenerating = false;
        this.fullTextContent = ''; // 重置纯文字内容
        
        // Clear display area
        document.getElementById('conversation-display').innerHTML = '';
        document.getElementById('text-only-display').textContent = '';
        document.getElementById('output-section').style.display = 'none';
        document.getElementById('text-only-section').style.display = 'none';
        
        this.updateStatus('Ready - Session Reset');
        this.updateUI();
        
        console.log('Frontend reset complete. New session ID:', this.sessionId);
    }
    
    updateUI() {
        const startBtn = document.getElementById('start-generation');
        const stopBtn = document.getElementById('stop-generation');
        const resetBtn = document.getElementById('reset-conversation');
        const promptInput = document.getElementById('user-prompt');
        
        startBtn.disabled = this.isGenerating || this.selectedModels.length === 0 || !promptInput.value.trim();
        stopBtn.disabled = !this.isGenerating;
        
        // Update button text
        if (this.isGenerating) {
            startBtn.textContent = '🔄 Generating...';
        } else {
            startBtn.textContent = '🚀 Start Generation';
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    const generator = new LLMTokenGenerator();
    
    // 监听提示词输入变化
    document.getElementById('user-prompt').addEventListener('input', () => {
        generator.updateStartButtonState();
    });
    
    // 监听API密钥输入变化
    document.querySelectorAll('.api-key-input').forEach(input => {
        input.addEventListener('input', () => {
            generator.updateSelectedModels();
        });
    });
    
    console.log('🚀 Multi-LLM Token Generator initialized!');
});
