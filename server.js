const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// ROTAS DE CONSULTA E CAUTELA
// ==========================================

// Pesquisar materiais por Código ou Nome
app.get('/api/materiais/busca/pesquisa', (req, res) => {
  const termo = req.query.q || '';
  if (!termo.trim()) return res.json([]);

  const query = `
    SELECT m.*, f.nome as usuario_atual, mov.data_retirada, mov.acessorios, mov.destino
    FROM materiais m
    LEFT JOIN movimentacoes mov ON m.id = mov.material_id AND mov.data_devolucao IS NULL
    LEFT JOIN funcionarios f ON mov.funcionario_id = f.id
    WHERE m.codigo_ref LIKE ? OR m.nome LIKE ?
    LIMIT 10
  `;
  const param = `%${termo.trim()}%`;
  
  db.all(query, [param, param], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Buscar status de um material específico
app.get('/api/materiais/:codigo', (req, res) => {
  const { codigo } = req.params;
  const query = `
    SELECT m.*, f.nome as usuario_atual, mov.data_retirada, mov.acessorios, mov.destino, mov.observacao
    FROM materiais m
    LEFT JOIN movimentacoes mov ON m.id = mov.material_id AND mov.data_devolucao IS NULL
    LEFT JOIN funcionarios f ON mov.funcionario_id = f.id
    WHERE m.codigo_ref = ? OR m.id = ?
  `;
  db.get(query, [codigo, codigo], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ message: 'Material não encontrado.' });
    res.json(row);
  });
});

// Empréstimo (Retirada)
app.post('/api/cautela/retirar', (req, res) => {
  const { codigo_ref, funcionario_id, acessorios, destino, observacao, data_retirada } = req.body;

  if (!funcionario_id || !destino) {
    return res.status(400).json({ error: 'Informe o funcionário responsável e o local/obra de destino.' });
  }

  db.get('SELECT * FROM materiais WHERE codigo_ref = ?', [codigo_ref], (err, material) => {
    if (err || !material) return res.status(404).json({ error: 'Material não encontrado.' });
    if (material.status === 'EM_USO') return res.status(400).json({ error: 'Material já está emprestado!' });
    if (material.status === 'MANUTENCAO') return res.status(400).json({ error: 'Material está em manutenção e não pode ser retirado!' });
    if (material.status === 'DANIFICADO') return res.status(400).json({ error: 'Material está danificado/baixado!' });

    const dataFinal = data_retirada || new Date().toISOString();

    db.run(
      `INSERT INTO movimentacoes (material_id, funcionario_id, acessorios, destino, observacao, data_retirada) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [material.id, funcionario_id, acessorios || '', destino, observacao || '', dataFinal],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        db.run('UPDATE materiais SET status = ? WHERE id = ?', ['EM_USO', material.id], () => {
          res.json({ message: 'Retirada registrada com sucesso!' });
        });
      }
    );
  });
});

// Devolução com Registro Detalhado de Estado e Ocorrências
app.post('/api/cautela/devolver', (req, res) => {
  const { codigo_ref, condicao_devolucao, tipo_ocorrencia, o_que, como, por_que, custo_providencia } = req.body;
  if (tipo_ocorrencia && !['SEM_AVARIA', 'MANUTENCAO', 'DANIFICADO'].includes(tipo_ocorrencia)) return res.status(400).json({ error: 'Estado de retorno inválido.' });
  if (tipo_ocorrencia && tipo_ocorrencia !== 'SEM_AVARIA' && !(o_que && como && por_que)) return res.status(400).json({ error: 'Informe o quê, como e por quê da ocorrência.' });
  const motivo_ocorrencia = o_que ? `O quê: ${o_que}\nComo: ${como}\nPor quê: ${por_que}` : '';

  db.get('SELECT * FROM materiais WHERE codigo_ref = ?', [codigo_ref], (err, material) => {
    if (err || !material) return res.status(404).json({ error: 'Material não encontrado.' });
    if (material.status !== 'EM_USO') return res.status(400).json({ error: 'Material não está emprestado.' });

    const queryMov = `
      UPDATE movimentacoes 
      SET data_devolucao = CURRENT_TIMESTAMP, 
          condicao_devolucao = ?,
          tipo_ocorrencia = ?,
          motivo_ocorrencia = ?,
          custo_providencia = ?
      WHERE material_id = ? AND data_devolucao IS NULL
    `;

    const estadoFinal = tipo_ocorrencia || 'SEM_AVARIA';
    let novoStatusMaterial = 'DISPONIVEL';

    if (estadoFinal === 'MANUTENCAO') novoStatusMaterial = 'MANUTENCAO';
    if (estadoFinal === 'DANIFICADO') novoStatusMaterial = 'DANIFICADO';

    db.run(
      queryMov, 
      [condicao_devolucao || 'Devolvido em ordem', estadoFinal, motivo_ocorrencia || '', custo_providencia || '', material.id], 
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        db.run('UPDATE materiais SET status = ? WHERE id = ?', [novoStatusMaterial, material.id], () => {
          res.json({ message: 'Devolução e registro de estado processados com sucesso!' });
        });
      }
    );
  });
});

// Alterar status de material diretamente (Reativar de manutenção/reparo)
app.post('/api/materiais/alterar-status', (req, res) => {
  const { id, novo_status } = req.body;
  if (!id || !['DISPONIVEL', 'MANUTENCAO', 'DANIFICADO'].includes(novo_status)) return res.status(400).json({ error: 'Dados inválidos.' });

  db.run("UPDATE materiais SET status = ? WHERE id = ? AND status != 'EM_USO'", [novo_status, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: `Status do material atualizado para ${novo_status}!` });
  });
});

// ==========================================
// ROTAS DE BALANÇO, HISTÓRICO E RELATÓRIOS
// ==========================================

// Histórico geral
app.get('/api/historico', (req, res) => {
  const query = `
    SELECT 
      mov.id,
      m.nome as material_nome,
      m.codigo_ref,
      m.categoria,
      f.nome as funcionario_nome,
      f.setor as funcionario_setor,
      mov.acessorios,
      mov.destino,
      mov.data_retirada,
      mov.data_devolucao,
      mov.observacao,
      mov.condicao_devolucao,
      mov.tipo_ocorrencia,
      mov.motivo_ocorrencia,
      mov.custo_providencia
    FROM movimentacoes mov
    JOIN materiais m ON mov.material_id = m.id
    JOIN funcionarios f ON mov.funcionario_id = f.id
    WHERE (? = '' OR date(mov.data_retirada) <= ?)
      AND (? = '' OR mov.data_devolucao IS NULL OR date(mov.data_devolucao) >= ?)
    ORDER BY mov.id DESC
  `;
  const { inicio = '', fim = '' } = req.query;
  db.all(query, [fim, fim, inicio, inicio], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Dados do Balanço Anual e Resumo do Patrimônio
app.get('/api/balanco/resumo', (req, res) => {
  db.all('SELECT status, COUNT(*) as qtd FROM materiais GROUP BY status', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const resumo = {
      total: 0,
      disponivel: 0,
      em_uso: 0,
      manutencao: 0,
      danificado: 0
    };

    rows.forEach(r => {
      resumo.total += r.qtd;
      if (r.status === 'DISPONIVEL') resumo.disponivel = r.qtd;
      if (r.status === 'EM_USO') resumo.em_uso = r.qtd;
      if (r.status === 'MANUTENCAO') resumo.manutencao = r.qtd;
      if (r.status === 'DANIFICADO') resumo.danificado = r.qtd;
    });

    res.json(resumo);
  });
});

// ==========================================
// ROTAS DE GESTÃO E CADASTROS
// ==========================================

app.get('/api/funcionarios', (req, res) => {
  db.all('SELECT * FROM funcionarios ORDER BY nome ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/funcionarios', (req, res) => {
  const { nome, setor } = req.body;
  if (!nome || !setor) {
    return res.status(400).json({ error: 'Preencha o nome e o setor do funcionário.' });
  }

  db.run(
    'INSERT INTO funcionarios (nome, setor) VALUES (?, ?)',
    [nome.trim(), setor.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao cadastrar funcionário.' });
      res.json({ message: 'Funcionário cadastrado com sucesso!' });
    }
  );
});

app.get('/api/materiais', (req, res) => {
  db.all('SELECT * FROM materiais ORDER BY nome ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/materiais', (req, res) => {
  const { codigo_ref, nome, categoria } = req.body;
  if (!codigo_ref || !nome || !categoria) {
    return res.status(400).json({ error: 'Preencha todos os campos do material.' });
  }

  db.run(
    'INSERT INTO materiais (codigo_ref, nome, categoria) VALUES (?, ?, ?)',
    [codigo_ref.trim().toUpperCase(), nome.trim(), categoria.trim()],
    function (err) {
      if (err) return res.status(400).json({ error: 'Código de etiqueta já existente.' });
      res.json({ message: 'Material cadastrado com sucesso!' });
    }
  );
});

// Dados de teste iniciais
app.get('/api/seed', (req, res) => {
  db.run(`INSERT OR IGNORE INTO funcionarios (id, nome, setor) VALUES 
    (1, 'Carlos Silva', 'Marcenaria'),
    (2, 'Ana Souza', 'Montagem')`);

  db.run(`INSERT OR IGNORE INTO materiais (id, codigo_ref, nome, categoria) VALUES 
    (1, 'FUR-001', 'Furadeira DeWalt 20V', 'Ferramentas Elétricas'),
    (2, 'SER-002', 'Serra Tico-Tico Bosch', 'Ferramentas Elétricas')`, () => {
      res.json({ message: 'Dados de teste criados com sucesso!' });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});