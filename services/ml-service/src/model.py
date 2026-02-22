import torch
import torch.nn as nn
from config import HIDDEN_SIZE, NUM_LAYERS, OUTPUT_WINDOW

class Attention(nn.Module):
    def __init__(self, hidden_dim):
        super().__init__()
        self.attn = nn.Linear(hidden_dim, 1)

    def forward(self, lstm_out):
        weights = torch.softmax(self.attn(lstm_out), dim=1)
        context = torch.sum(weights * lstm_out, dim=1)
        return context

class LSTMModel(nn.Module):
    def __init__(self, input_dim):
        super().__init__()

        self.lstm = nn.LSTM(
            input_dim,
            HIDDEN_SIZE,
            NUM_LAYERS,
            batch_first=True
        )

        self.attention = Attention(HIDDEN_SIZE)

        self.fc = nn.Linear(HIDDEN_SIZE, OUTPUT_WINDOW * input_dim)

    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        context = self.attention(lstm_out)
        out = self.fc(context)
        return out
