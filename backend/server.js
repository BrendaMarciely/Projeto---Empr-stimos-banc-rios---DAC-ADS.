const express = require("express")
const mysql = require("mysql2")
const cors = require("cors")

const app = express()

// Configuração do CORS
app.use(cors())
app.use(express.json())

// ================= CONEXÃO =================

const conexao = mysql.createPool({
    host: "crossover.proxy.rlwy.net",
    user: "root",
    password: "AoiBmJQWLOwFvyGzVoFcWwsVibRAUFTI",
    database: "railway",
    port: 26823,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
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

// ================= EXCLUIR EMPRÉSTIMO + PARCELAS (CORRIGIDO PARA POOL) =================
app.delete("/excluir_emprestimo/:id", (req, res) => {
    const id = req.params.id;

    // 1. Solicita uma conexão exclusiva do pool para a transação
    conexao.getConnection((err, conn) => {
        if (err) {
            console.error("❌ Erro ao obter conexão do pool:", err);
            return res.status(500).json({ msg: "Erro no servidor ao processar exclusão" });
        }

        // 2. Inicia a transação na conexão aberta (conn)
        conn.beginTransaction((errB) => {
            if (errB) {
                conn.release(); // Sempre devolva a conexão se falhar aqui
                return res.status(500).json({ msg: "Erro ao processar transação" });
            }

            const sqlParcelas = "DELETE FROM tbContasPagar WHERE emprestimo_id = ?";
            conn.query(sqlParcelas, [id], (erroP) => {
                if (erroP) {
                    return conn.rollback(() => {
                        conn.release(); // Libera a conexão no rollback
                        res.status(500).json({ msg: "Erro nas parcelas" });
                    });
                }

                const sqlEmprestimo = "DELETE FROM tbEmprestimos WHERE emprestimo_id = ?";
                conn.query(sqlEmprestimo, [id], (erroE) => {
                    if (erroE) {
                        return conn.rollback(() => {
                            conn.release(); // Libera a conexão no rollback
                            res.status(500).json({ msg: "Erro no empréstimo" });
                        });
                    }

                    // 3. Confirma as alterações se tudo correr bem
                    conn.commit((errC) => {
                        if (errC) {
                            return conn.rollback(() => {
                                conn.release();
                            });
                        }
                        
                        conn.release(); // ⚠️ ESSENCIAL: Devolve a conexão limpa para o pool
                        res.json({ msg: "Removido com sucesso! ✅" });
                    });
                });
            });
        });
    });
});

// ================= CRUD FINANCEIRAS COMPLETO =================



// --- LISTAR FINANCEIRAS ---
app.get("/listar_financeiras", (req, res) => {

    const sql = `
        SELECT financeira_id, descricao, sigla
        FROM tbFinanceira
        ORDER BY descricao ASC
    `;

    conexao.query(sql, (erro, resultado) => {

        if (erro) {
            console.log("Erro ao listar financeiras:", erro);
            return res.status(500).json([]);
        }

        res.json(resultado);
    });
});




















// --- BUSCAR DETALHES DE UMA FINANCEIRA ---
app.get("/financeira_detalhes/:id", (req, res) => {
    const id = req.params.id;
    const sql = "SELECT * FROM tbFinanceira WHERE financeira_id = ?";
    conexao.query(sql, [id], (erro, resultado) => {
        if (erro || resultado.length === 0) return res.status(404).json({ msg: "Não encontrado" });
        res.json(resultado[0]);
    });
});

// --- CADASTRAR FINANCEIRA (COM VERIFICAÇÃO DE SIGLA DUPLICADA) ---
app.post("/cadastrar_financeira", (req, res) => {
    const { descricao, sigla } = req.body;
    const sql = "INSERT INTO tbFinanceira (descricao, sigla) VALUES (?, ?)";
    
    conexao.query(sql, [descricao, sigla.toUpperCase()], (erro) => {
        if (erro) {
            // Verifica se o erro é de entrada duplicada
            if (erro.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ msg: "Esta sigla já está cadastrada para outro banco! ⚠️" });
            }
            console.error("Erro ao cadastrar:", erro);
            return res.status(500).json({ msg: "Erro ao cadastrar financeira." });
        }
        res.json({ msg: "Financeira cadastrada! ✅" });
    });
});

// --- EDITAR FINANCEIRA (COM VERIFICAÇÃO DE SIGLA DUPLICADA) ---
app.put("/editar_financeira/:id", (req, res) => {
    const id = req.params.id;
    const { descricao, sigla } = req.body;
    const sql = "UPDATE tbFinanceira SET descricao = ?, sigla = ? WHERE financeira_id = ?";
    
    conexao.query(sql, [descricao, sigla.toUpperCase(), id], (erro) => {
        if (erro) {
            // Verifica se a nova sigla já pertence a outra financeira
            if (erro.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ msg: "Não foi possível atualizar: esta sigla já está em uso! ⚠️" });
            }
            console.error("Erro ao editar:", erro);
            return res.status(500).json({ msg: "Erro ao atualizar financeira." });
        }
        res.json({ msg: "Financeira atualizada! ✅" });
    });
});

// --- EXCLUIR FINANCEIRA ---
app.delete("/excluir_financeira/:id", (req, res) => {
    const id = req.params.id;
    const sql = "DELETE FROM tbFinanceira WHERE financeira_id = ?";
    conexao.query(sql, [id], (erro) => {
        if (erro) return res.status(500).json({ msg: "Erro ao excluir" });
        res.json({ msg: "Removida com sucesso!" });
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



// --- BUSCAR DETALHES DE UM USUÁRIO ---
app.get("/usuario_detalhes/:id", (req, res) => {
    const id = req.params.id;
    const sql = "SELECT usuario_id, nome, login, perfil FROM tbUsuarios WHERE usuario_id = ?";
    conexao.query(sql, [id], (erro, resultado) => {
        if (erro || resultado.length === 0) return res.status(404).json({ msg: "Usuário não encontrado" });
        res.json(resultado[0]);
    });
});

// --- CADASTRAR NOVO USUÁRIO (VERSÃO CORRIGIDA) ---
app.post("/cadastrar", (req, res) => {
    const { nome, login, senha, perfil } = req.body;
    const sql = "INSERT INTO tbUsuarios (nome, login, senha, perfil) VALUES (?, ?, ?, ?)";
    
    conexao.query(sql, [nome, login, senha, perfil], (erro) => {
        if (erro) {
            // Verifica se o erro é de entrada duplicada (Código ER_DUP_ENTRY do MySQL)
            if (erro.code === 'ER_DUP_ENTRY') {
                console.log("⚠️ Tentativa de cadastro com login duplicado:", login);
                return res.status(400).json({ mensagem: "Este Login/E-mail já está cadastrado. Por favor, use outro." });
            }
            
            console.error("❌ Erro no banco:", erro.message);
            return res.status(500).json({ mensagem: "Erro interno ao cadastrar usuário." });
        }
        
        res.json({ mensagem: "Usuário cadastrado com sucesso!" });
    });
});

// --- EDITAR USUÁRIO ---
app.put("/editar_usuario/:id", (req, res) => {
    const id = req.params.id;
    const { nome, login, perfil } = req.body;
    const sql = "UPDATE tbUsuarios SET nome = ?, login = ?, perfil = ? WHERE usuario_id = ?";
    
    conexao.query(sql, [nome, login, perfil, id], (erro) => {
        if (erro) {
            // Trata duplicidade também na edição
            if (erro.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ mensagem: "Este Login/E-mail já pertence a outro usuário." });
            }
            return res.status(500).json({ mensagem: "Erro ao atualizar usuário" });
        }
        res.json({ mensagem: "Usuário atualizado com sucesso!" });
    });
});

// --- EXCLUIR USUÁRIO ---
app.delete("/excluir_usuario/:id", (req, res) => {
    const id = req.params.id;
    const sql = "DELETE FROM tbUsuarios WHERE usuario_id = ?";
    conexao.query(sql, [id], (erro) => {
        if (erro) return res.status(500).json({ mensagem: "Erro ao excluir usuário" });
        res.json({ mensagem: "Usuário removido!" });
    });
});






// ================= ALERTAS / NOTIFICAÇÕES =================
app.get("/alertas_notificacoes", (req, res) => { // Corrigido de aapp para app
    const sqlAtrasados = `
        SELECT 
            e.credor,
            p.data_vencimento,
            DATEDIFF(CURDATE(), STR_TO_DATE(p.data_vencimento, '%Y%m%d')) AS dias_diferenca
        FROM tbContasPagar p
        INNER JOIN tbEmprestimos e ON p.emprestimo_id = e.emprestimo_id
        WHERE p.data_vencimento < REPLACE(CURDATE(), '-', '')
    `;

    const sqlProximos = `
        SELECT 
            e.credor,
            p.data_vencimento,
            DATEDIFF(STR_TO_DATE(p.data_vencimento, '%Y%m%d'), CURDATE()) AS dias_diferenca
        FROM tbContasPagar p
        INNER JOIN tbEmprestimos e ON p.emprestimo_id = e.emprestimo_id
        WHERE p.data_vencimento BETWEEN REPLACE(CURDATE(), '-', '') AND REPLACE(DATE_ADD(CURDATE(), INTERVAL 15 DAY), '-', '')
    `;

    conexao.query(sqlAtrasados, (err1, atrasados) => {
        if (err1) return res.status(500).json({ erro: err1.message });
        conexao.query(sqlProximos, (err2, proximos) => {
            if (err2) return res.status(500).json({ erro: err2.message });
            res.json({ atrasados, proximos });
        });
    });
});





// ================= RELATÓRIO: FLUXO DE CAIXA =================
app.get("/relatorio_fluxo", (req, res) => {
    // Convertendo o INT para formato de data para o DATE_FORMAT funcionar
    const sql = `
        SELECT 
            DATE_FORMAT(STR_TO_DATE(data_vencimento, '%Y%m%d'), '%Y-%m') AS mes,
            SUM(valor) AS saidas,
            0 AS entradas,
            -SUM(valor) AS saldo
        FROM tbContasPagar
        GROUP BY mes
        ORDER BY mes
    `;

    conexao.query(sql, (erro, resultado) => {
        if (erro) return res.status(500).json([]);
        res.json(resultado);
    });
});


// ================= RELATÓRIO: DÍVIDA POR CREDOR =================
app.get("/relatorio_credores", (req, res) => {
    const sql = `
        SELECT 
            credor, 
            SUM(valor) AS saldo_devedor,
            ROUND((SUM(valor) / (SELECT SUM(valor) FROM tbEmprestimos WHERE status = 'Ativo') * 100), 1) AS porcentagem
        FROM tbEmprestimos 
        WHERE status = 'Ativo'
        GROUP BY credor
    `;

    conexao.query(sql, (erro, resultado) => {
        if (erro) {
            console.log("Erro relatorio credores:", erro);
            return res.status(500).json([]);
        }
        res.json(resultado);
    });
});








// Railway Escolha Automática
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});