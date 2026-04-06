const express = require("express")
const mysql = require("mysql2")
const cors = require("cors")

const app = express()

// Configuração do CORS para permitir que o Vercel acesse o Railway
app.use(cors())
app.use(express.json())

// ================= CONEXÃO =================
const conexao = mysql.createConnection({
    host: "crossover.proxy.rlwy.net",
    user: "root",
    password: "AoiBmJQWLOwFvyGzVoFcWwsVibRAUFTI",
    database: "railway",
    port: 26823
})

conexao.connect((erro) => {
    if (erro) {
        console.log("❌ Erro ao conectar no banco:", erro.message)
    } else {
        console.log("✅ Conectado ao banco Railway")
    }
})

// ================= CADASTRAR EMPRÉSTIMO + PARCELAS =================
app.post("/cadastrar_emprestimo", (req, res) => {
    const { credor, valor, taxa, data, vencimento, parcelas, usuario_id } = req.body;

    const valorNum = parseFloat(valor);
    const taxaNum = parseFloat(taxa);
    const qtdParcelas = parseInt(parcelas);

    const sqlEmprestimo = `
        INSERT INTO tbEmprestimos 
        (credor, valor, taxa_juros, data, vencimento, financeira_id, atualizado_por, status) 
        VALUES (?, ?, ?, ?, ?, 1, ?, 'Ativo')
    `;

    conexao.query(sqlEmprestimo, [credor, valorNum, taxaNum, data, vencimento, usuario_id || 1], (erro, resultado) => {
        if (erro) {
            console.log("❌ Erro SQL no Empréstimo:", erro.sqlMessage);
            return res.status(500).json({ msg: "Erro ao salvar empréstimo" });
        }

        const emprestimoId = resultado.insertId;
        const valorCadaParcela = valorNum / qtdParcelas;
        
        console.log(`🚀 Gerando ${qtdParcelas} parcelas para o empréstimo ${emprestimoId}...`);

        for (let i = 1; i <= qtdParcelas; i++) {
            let dataBase = new Date(data + "T12:00:00"); 
            dataBase.setMonth(dataBase.getMonth() + i);
            
            const ano = dataBase.getFullYear();
            const mes = String(dataBase.getMonth() + 1).padStart(2, '0');
            const dia = String(dataBase.getDate()).padStart(2, '0');
            const dataFinalMySQL = `${ano}-${mes}-${dia}`;

            const sqlParcela = `
                INSERT INTO tbContasPagar (emprestimo_id, valor, data_vencimento, atualizado_em) 
                VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), NOW())
            `;
            
            conexao.query(sqlParcela, [emprestimoId, valorCadaParcela, dataFinalMySQL], (err) => {
                if (err) {
                    console.log(`❌ ERRO NA PARCELA ${i}:`, err.sqlMessage);
                } else {
                    console.log(`✅ Parcela ${i} salva com sucesso! (${dataFinalMySQL})`);
                }
            });
        }

        res.json({ msg: "Empréstimo e parcelas gerados com sucesso! ✅" });
    });
});

// ================= LISTAR EMPRESTIMOS =================
app.get("/listar_emprestimos", (req, res) => {
    const sql = `SELECT emprestimo_id, credor, valor, taxa_juros, data, vencimento, status FROM tbEmprestimos ORDER BY emprestimo_id DESC`
    conexao.query(sql, (erro, resultado) => {
        if (erro) return res.json([]);
        res.json(resultado);
    });
});

// ================= LOGIN & USUÁRIOS =================
app.post("/cadastrar", (req, res) => {
    const { nome, login, senha, perfil } = req.body;
    const sql = `INSERT INTO tbUsuarios (nome, login, senha, perfil) VALUES (?, ?, ?, ?)`;
    conexao.query(sql, [nome, login, senha, perfil || 'Tesouraria'], (erro) => {
        if (erro) return res.json({ msg: "Erro ao cadastrar" });
        res.json({ msg: "Usuário cadastrado com sucesso" });
    });
});

app.post("/login", (req, res) => {
    const { login, senha } = req.body;
    const sql = `SELECT usuario_id, nome FROM tbUsuarios WHERE login = ? AND senha = ?`;
    conexao.query(sql, [login, senha], (erro, resultado) => {
        if (resultado && resultado.length > 0) res.json({ msg: "ok", usuario: resultado[0] });
        else res.json({ msg: "invalido" });
    });
});

// ================= EXCLUIR =================
app.delete("/excluir_emprestimo/:id", (req, res) => {
    const id = req.params.id;
    const sql = "DELETE FROM tbEmprestimos WHERE emprestimo_id = ?";
    conexao.query(sql, [id], (erro) => {
        if (erro) return res.status(500).json({ msg: "Erro ao excluir" });
        res.json({ msg: "Empréstimo removido com sucesso!" });
    });
});

// ================= EDIÇÃO =================
app.get("/emprestimo/:id", (req, res) => {
    const id = req.params.id;
    const sql = "SELECT * FROM tbEmprestimos WHERE emprestimo_id = ?";
    conexao.query(sql, [id], (erro, resultado) => {
        if (erro) return res.status(500).json({ msg: "Erro ao buscar" });
        res.json(resultado[0]);
    });
});

app.put("/editar_emprestimo/:id", (req, res) => {
    const id = req.params.id;
    const { credor, valor, taxa, data, vencimento, status } = req.body;
    const sql = `UPDATE tbEmprestimos SET credor = ?, valor = ?, taxa_juros = ?, data = ?, vencimento = ?, status = ? WHERE emprestimo_id = ?`;
    conexao.query(sql, [credor, valor, taxa, data, vencimento, status, id], (erro) => {
        if (erro) return res.status(500).json({ msg: "Erro ao atualizar" });
        res.json({ msg: "Empréstimo atualizado com sucesso! ✅" });
    });
});

// ================= DASHBOARD =================
app.get("/dashboard_resumo", (req, res) => {
    const sql = `SELECT COUNT(*) as total_pedidos, SUM(valor) as soma_total, COUNT(DISTINCT credor) as total_credores FROM tbEmprestimos`;
    conexao.query(sql, (erro, resultado) => {
        if (erro) return res.status(500).json({ msg: "Erro no dashboard" });
        res.json(resultado[0]);
    });
});

// ================= NOTIFICAÇÕES =================
app.get("/alertas_notificacoes", (req, res) => {
    const sql = `SELECT credor, vencimento, DATEDIFF(vencimento, CURDATE()) as dias_diferenca FROM tbEmprestimos WHERE status = 'Ativo' ORDER BY vencimento ASC`;
    conexao.query(sql, (erro, resultados) => {
        if (erro) return res.status(500).json({ msg: "Erro ao buscar alertas" });
        const atrasados = resultados.filter(item => item.dias_diferenca < 0);
        const proximos = resultados.filter(item => item.dias_diferenca >= 0 && item.dias_diferenca <= 15);
        res.json({ atrasados, proximos });
    });
});

// ================= RELATÓRIO CREDORES =================
app.get("/relatorio_credores", (req, res) => {
    const sql = `SELECT credor, SUM(valor) as saldo_devedor, (SUM(valor) / (SELECT SUM(valor) FROM tbEmprestimos) * 100) as porcentagem FROM tbEmprestimos GROUP BY credor ORDER BY saldo_devedor DESC`;
    conexao.query(sql, (erro, resultados) => {
        if (erro) return res.status(500).json({ msg: "Erro ao gerar relatório" });
        res.json(resultados);
    });
});

// ================= RELATÓRIO FLUXO DE CAIXA =================
app.get("/relatorio_fluxo", (req, res) => {
    const sql = `
        SELECT 
            DATE_FORMAT(STR_TO_DATE(data_vencimento, '%Y%m%d'), '%b/%Y') as mes_texto, 
            SUM(valor) as total_saidas
        FROM tbContasPagar 
        GROUP BY mes_texto
        ORDER BY MIN(data_vencimento) ASC 
        LIMIT 6
    `;
    
    conexao.query(sql, (erro, resultados) => {
        if (erro) {
            console.log("❌ Erro detalhado no SQL de fluxo:", erro.sqlMessage);
            return res.status(500).json({ msg: "Erro ao buscar fluxo", erro: erro.sqlMessage });
        }
        
        const fluxoFormatado = resultados.map(item => {
            const entradas = 180000; 
            const saidasReal = parseFloat(item.total_saidas) || 0;
            return {
                mes: item.mes_texto,
                entradas: entradas,
                saidas: saidasReal,
                saldo: entradas - saidasReal
            };
        });
        res.json(fluxoFormatado);
    });
});




// ================= CRUD DE USUÁRIOS (TELA ADM) =================

// 1. LISTAR TODOS OS USUÁRIOS
app.get("/listar_usuarios", (req, res) => {
    const sql = "SELECT usuario_id, nome, login, perfil, status FROM tbUsuarios";
    conexao.query(sql, (erro, resultados) => {
        if (erro) return res.status(500).json({ msg: "Erro ao buscar usuários" });
        res.json(resultados);
    });
});

// 2. ALTERAR STATUS (Ativar/Desativar)
app.put("/alterar_status_usuario/:id", (req, res) => {
    const { novoStatus } = req.body;
    const sql = "UPDATE tbUsuarios SET status = ? WHERE usuario_id = ?";
    conexao.query(sql, [novoStatus, req.params.id], (erro) => {
        if (erro) return res.status(500).json({ msg: "Erro ao atualizar status" });
        res.json({ msg: "Status atualizado com sucesso!" });
    });
});

// 3. EDITAR USUÁRIO (Nome e Perfil)
app.put("/editar_usuario/:id", (req, res) => {
    const { nome, perfil } = req.body;
    const sql = "UPDATE tbUsuarios SET nome = ?, perfil = ? WHERE usuario_id = ?";
    conexao.query(sql, [nome, perfil, req.params.id], (erro) => {
        if (erro) return res.status(500).json({ msg: "Erro ao editar usuário" });
        res.json({ msg: "Usuário editado com sucesso!" });
    });
});

// 4. EXCLUIR USUÁRIO
app.delete("/excluir_usuario/:id", (req, res) => {
    const sql = "DELETE FROM tbUsuarios WHERE usuario_id = ?";
    conexao.query(sql, [req.params.id], (erro) => {
        if (erro) return res.status(500).json({ msg: "Erro ao excluir usuário" });
        res.json({ msg: "Usuário removido com sucesso!" });
    });
});





// Ajuste para o Railway escolher a porta automaticamente
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});