const express = require("express")
const mysql = require("mysql2")
const cors = require("cors")

const app = express()

// Configuração do CORS
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

// ================= DASHBOARD (FILTRANDO APENAS ATIVOS) =================
app.get("/dashboard_resumo", (req, res) => {
    // 1. total_pedidos: Conta apenas onde o status é 'Ativo'
    // 2. soma_total: Soma o valor apenas dos 'Ativos'
    // 3. total_credores: Conta as financeiras
    // 4. parcelas_proximas: Conta parcelas na tbContasPagar que vencem nos próximos 30 dias
    const sql = `
        SELECT 
            (SELECT COUNT(*) FROM tbEmprestimos WHERE status = 'Ativo') as total_pedidos,
            (SELECT IFNULL(SUM(valor), 0) FROM tbEmprestimos WHERE status = 'Ativo') as soma_total,
            (SELECT COUNT(*) FROM tbFinanceira) as total_credores,
            (SELECT COUNT(*) FROM tbContasPagar 
             WHERE data_vencimento BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)) as parcelas_proximas
    `;

    conexao.query(sql, (erro, resultado) => {
        if (erro) {
            console.error("❌ Erro no SQL do Dashboard:", erro);
            return res.status(500).json({ msg: "Erro interno" });
        }
        // Envia o objeto com os 4 valores para o HTML
        res.json(resultado[0]);
    });
});
// Rota para buscar detalhes de um empréstimo (AJUSTADA)
app.get("/buscar_emprestimo/:id", (req, res) => {
    const id = req.params.id;
    const sql = "SELECT * FROM tbEmprestimos WHERE emprestimo_id = ?";
    conexao.query(sql, [id], (erro, resultado) => {
        if (erro) return res.status(500).json({ msg: "Erro no banco" });
        if (resultado.length === 0) return res.status(404).json({ msg: "Empréstimo não encontrado" });
        res.json(resultado[0]);
    });
});
// ================= EDITAR EMPRÉSTIMO (VIA MODAL) =================
app.put("/editar_emprestimo/:id", (req, res) => {
    const id = req.params.id;
    const { valor, taxa, status } = req.body;
    
    const sql = `
        UPDATE tbEmprestimos 
        SET valor = ?, taxa_juros = ?, status = ?, atualizado_em = NOW() 
        WHERE emprestimo_id = ?
    `;
    
    conexao.query(sql, [valor, taxa, status, id], (erro, resultado) => {
        if (erro) return res.status(500).json({ msg: "Erro ao atualizar" });
        res.json({ msg: "Empréstimo atualizado com sucesso! ✅" });
    });
});

// ================= CADASTRAR EMPRÉSTIMO + PARCELAS =================
app.post("/cadastrar_emprestimo", (req, res) => {
    const { credor, valor, taxa, data, vencimento, parcelas, usuario_id, financeira_id } = req.body;

    const valorNum = parseFloat(valor);
    const taxaNum = parseFloat(taxa);
    const qtdParcelas = parseInt(parcelas);
    const finId = parseInt(financeira_id) || 1;

    const sqlEmprestimo = `
        INSERT INTO tbEmprestimos 
        (credor, valor, taxa_juros, data, vencimento, financeira_id, atualizado_por, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Ativo')
    `;

    conexao.query(sqlEmprestimo, [credor, valorNum, taxaNum, data, vencimento, finId, usuario_id || 1], (erro, resultado) => {
        if (erro) {
            console.error("Erro ao inserir empréstimo:", erro);
            return res.status(500).json({ msg: "Erro ao salvar empréstimo" });
        }

        const emprestimoId = resultado.insertId;
        const valorCadaParcela = valorNum / qtdParcelas;
        
        // Vamos criar um array de promessas para garantir que todas as parcelas sejam inseridas
        let insercoes = [];

        for (let i = 1; i <= qtdParcelas; i++) {
            let dataBase = new Date(data + "T12:00:00"); 
            dataBase.setMonth(dataBase.getMonth() + i);
            const dataFinalMySQL = dataBase.toISOString().split('T')[0];

            const sqlParcela = `
                INSERT INTO tbContasPagar (emprestimo_id, valor, data_vencimento, atualizado_em) 
                VALUES (?, ?, ?, NOW())
            `;
            
            // Executando a inserção da parcela
            conexao.query(sqlParcela, [emprestimoId, valorCadaParcela, dataFinalMySQL], (errP) => {
                if (errP) console.error("Erro ao inserir parcela " + i, errP);
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

// ================= EXCLUIR EMPRÉSTIMO + PARCELAS =================
app.delete("/excluir_emprestimo/:id", (req, res) => {
    const id = req.params.id;
    conexao.beginTransaction((errB) => {
        if (errB) return res.status(500).json({ msg: "Erro ao processar" });

        const sqlParcelas = "DELETE FROM tbContasPagar WHERE emprestimo_id = ?";
        conexao.query(sqlParcelas, [id], (erroP) => {
            if (erroP) return conexao.rollback(() => res.status(500).json({ msg: "Erro nas parcelas" }));

            const sqlEmprestimo = "DELETE FROM tbEmprestimos WHERE emprestimo_id = ?";
            conexao.query(sqlEmprestimo, [id], (erroE) => {
                if (erroE) return conexao.rollback(() => res.status(500).json({ msg: "Erro no empréstimo" }));

                conexao.commit((errC) => {
                    if (errC) return conexao.rollback(() => res.status(500).json({ msg: "Erro final" }));
                    res.json({ msg: "Removido com sucesso! ✅" });
                });
            });
        });
    });
});

// ================= CRUD FINANCEIRAS =================
app.get("/listar_financeiras", (req, res) => {
    const sql = "SELECT * FROM tbFinanceira ORDER BY financeira_id DESC";
    conexao.query(sql, (erro, resultado) => {
        if (erro) return res.status(500).json({ mensagem: "Erro ao listar" });
        res.json(resultado);
    });
});

// ================= LOGIN & USUÁRIOS =================
app.post("/login", (req, res) => {
    const { login, senha } = req.body;
    const sql = `SELECT usuario_id, nome FROM tbUsuarios WHERE login = ? AND senha = ?`;
    conexao.query(sql, [login, senha], (erro, resultado) => {
        if (resultado && resultado.length > 0) res.json({ msg: "ok", usuario: resultado[0] });
        else res.json({ msg: "invalido" });
    });
});

app.get("/listar_usuarios", (req, res) => {
    const sql = "SELECT usuario_id, nome, login, perfil FROM tbUsuarios ORDER BY nome ASC";
    conexao.query(sql, (erro, resultado) => {
        if (erro) return res.status(500).json({ mensagem: "Erro" });
        res.json(resultado);
    });
});

// Railway Escolha Automática
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});