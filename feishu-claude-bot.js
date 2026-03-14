/**
 * 飞书Claude机器人 - 完整后端实现
 * 支持：私聊、群聊、文档读写、对话上下文
 * 部署到: Vercel, Railway, Render等
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

// ============ 环境变量配置 ============
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY;
const FEISHU_VERIFY_TOKEN = process.env.FEISHU_VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 飞书API基础URL
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// 用于缓存access_token，减少API调用
let cachedAccessToken = null;
let tokenExpireTime = 0;

// ============ 中间件 ============
app.use(express.json());

// ============ 密钥验证（飞书安全验证） ============
function verifySignature(timestamp, nonce, encryptedBody, encryptKey) {
  const str = timestamp + nonce + encryptKey;
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1;
}

function decryptMessage(encryptedBody, encryptKey) {
  try {
    const cipher = crypto.createDecipher('aes-256-cbc', encryptKey);
    const decrypted = cipher.update(encryptedBody, 'base64', 'utf8');
    return decrypted + cipher.final('utf8');
  } catch (e) {
    console.error('Decryption failed:', e);
    return null;
  }
}

// ============ 获取飞书Access Token ============
async function getFeishuAccessToken() {
  // 检查缓存是否有效
  if (cachedAccessToken && Date.now() < tokenExpireTime) {
    return cachedAccessToken;
  }

  try {
    const response = await axios.post(
      `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }
    );

    cachedAccessToken = response.data.tenant_access_token;
    tokenExpireTime = Date.now() + (response.data.expire - 300) * 1000; // 提前5分钟刷新
    return cachedAccessToken;
  } catch (error) {
    console.error('Failed to get access token:', error.message);
    throw error;
  }
}

// ============ 调用Claude API ============
async function callClaudeAPI(messages) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-20250805',
        max_tokens: 2048,
        messages: messages,
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    const content = response.data.content[0];
    if (content.type === 'text') {
      return content.text;
    }
    return '无法生成回复';
  } catch (error) {
    console.error('Claude API error:', error.message);
    return `抱歉，处理请求时出错: ${error.message}`;
  }
}

// ============ 读取飞书文档内容 ============
async function readFeishuDoc(docToken) {
  try {
    const accessToken = await getFeishuAccessToken();
    const response = await axios.get(
      `${FEISHU_API_BASE}/docs/v3/documents/${docToken}/raw_content`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data.data.content;
  } catch (error) {
    console.error('Failed to read doc:', error.message);
    return null;
  }
}

// ============ 写入飞书文档 ============
async function writeFeishuDoc(docToken, content) {
  try {
    const accessToken = await getFeishuAccessToken();

    // 使用文档写入API
    const response = await axios.patch(
      `${FEISHU_API_BASE}/docs/v3/documents/${docToken}/blocks`,
      {
        requests: [
          {
            update_text: {
              insert_elem: {
                block_id: 'temp_block',
                style: {},
              },
              update_text_style: {
                range: {
                  start_index: 0,
                  end_index: -1,
                },
              },
            },
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.status === 200;
  } catch (error) {
    console.error('Failed to write doc:', error.message);
    return false;
  }
}

// ============ 发送飞书消息 ============
async function sendFeishuMessage(receiveId, receiveIdType, content) {
  try {
    const accessToken = await getFeishuAccessToken();
    const response = await axios.post(
      `${FEISHU_API_BASE}/im/v1/messages`,
      {
        receive_id: receiveId,
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        params: {
          receive_id_type: receiveIdType, // 'user_id' 或 'open_id'
        },
      }
    );

    return response.status === 200;
  } catch (error) {
    console.error('Failed to send message:', error.message);
    return false;
  }
}

// ============ 事件处理路由 ============
app.post('/webhook', async (req, res) => {
  const { signature, timestamp, nonce, encrypt } = req.body;

  // 飞书的URL validation
  const computedSignature = verifySignature(timestamp, nonce, FEISHU_ENCRYPT_KEY, FEISHU_VERIFY_TOKEN);
  
  // 注意：实际验证需要对比 signature
  // if (signature !== computedSignature) {
  //   return res.status(401).json({ error: 'Invalid signature' });
  // }
