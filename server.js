const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello, welcome to the WebSocket server!');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

let lobbies = {};
let puzzles = {};

function generateLobbyCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

wss.on('connection', ws => {
    console.log('Player connected.');

    ws.on('message', message => {
        const data = JSON.parse(message);

        switch (data.action) {
            case 'createLobby':
                const lobbyCode = generateLobbyCode();
                const size = data.size || 3;
                const playerName = data.playerName;

                lobbies[lobbyCode] = {
                    players: [{
                        socket: ws,
                        name: playerName,
                        lobby: lobbyCode // Speichere Lobby-Code im Spielerobjekt
                    }],
                    gameStarted: false
                };

                puzzles[lobbyCode] = {
                    puzzle: [],
                    size: size,
                    tilesize: 100,
                    completed: false
                };

                ws.lobbyCode = lobbyCode; // Speichere den Lobby-Code im WebSocket

                ws.send(JSON.stringify({
                    action: 'lobbyCreated',
                    code: lobbyCode,
                    size: size,
                    players: lobbies[lobbyCode].players.map(p => ({ name: p.name }))
                }));

                break;

            case 'joinLobby':
                if (!lobbies[data.code]) {
                    ws.send(JSON.stringify({
                        action: 'lobbyNotFound'
                    }));
                    return;
                }
                if (lobbies[data.code] && lobbies[data.code].players.length < 2) {
                    const existingPlayers = lobbies[data.code].players;

                    if (existingPlayers.some(p => p.name === data.playerName)) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: 'A player with this name already exists in the lobby.'
                        }));
                        return;
                    }

                    existingPlayers.push({
                        socket: ws,
                        name: data.playerName,
                        lobby: data.code // Speichere Lobby-Referenz
                    });

                    ws.lobbyCode = data.code;

                    existingPlayers.forEach(player => {
                        player.socket.send(JSON.stringify({
                            action: 'updatePlayerList',
                            players: existingPlayers.map(p => ({ name: p.name }))
                        }));
                    });

                    ws.send(JSON.stringify({
                        action: 'lobbyJoined',
                        code: data.code,
                        size: puzzles[data.code].size,
                        players: existingPlayers.map(p => ({ name: p.name }))
                    }));
                } else {
                    ws.send(JSON.stringify({
                        action: 'lobbyFull',
                        message: 'Lobby is full or does not exist.'
                    }));
                }
                break;

            case 'startGame':
                const currentLobby = ws.lobbyCode;
                if (
                    lobbies[currentLobby] &&
                    lobbies[currentLobby].players.length === 2 &&
                    !lobbies[currentLobby].gameStarted &&
                    !puzzles[currentLobby].completed
                ) {
                    lobbies[currentLobby].gameStarted = true;

                    const puzzle = generatePuzzle(currentLobby);

                    lobbies[currentLobby].players.forEach(player => {
                        player.socket.send(JSON.stringify({ action: 'gameStarted', puzzle }));
                    });
                }
                break;

            case 'move':
                const moveLobby = ws.lobbyCode;
                if (lobbies[moveLobby] && lobbies[moveLobby].gameStarted) {
                    puzzles[moveLobby].puzzle = data.puzzle;
                    syncPuzzleToPlayers(moveLobby);
                    checkIfSolved(moveLobby);
                }
                break;

            case 'puzzleSolved':
                const solvedLobby = ws.lobbyCode;
                puzzles[solvedLobby].completed = true;
                lobbies[solvedLobby].players.forEach(player => {
                    player.socket.send(JSON.stringify({ action: 'gameOver' }));
                });
                puzzles[solvedLobby].completed = false;
                lobbies[solvedLobby].gameStarted = false;
                puzzles[solvedLobby].puzzle = [];
                break;

            case 'leaveLobby':
                const leaveLobby = ws.lobbyCode;
                handleLeaveLobby(ws, leaveLobby, data.playerName);
                break;
        }
    });

    ws.on('close', () => {
        console.log('Player disconnected.');
        const disconnectLobby = ws.lobbyCode;
        if (disconnectLobby && lobbies[disconnectLobby]) {
            handleLeaveLobby(ws, disconnectLobby);
        }
    });
});

function generatePuzzle(currentLobby) {
    if (!puzzles[currentLobby]) {
        throw new Error(`Puzzle data for lobby ${currentLobby} not found.`);
    }

    let size = puzzles[currentLobby].size;
    let tilesize = puzzles[currentLobby].tilesize;

    createPuzzle(size, tilesize, currentLobby);

    do {
        randomizePuzzle(size, currentLobby);
    } while (!isPuzzleValid(size, currentLobby) || !validateEmptyPuzzle(currentLobby));

    return puzzles[currentLobby].puzzle;
}

function createPuzzle(size, tilesize, currentLobby) {
    for (let i = 1; i <= size * size; i++) {
        puzzles[currentLobby].puzzle.push({
            value: i === size * size ? null : i,
            position: i,
            x: (getCol(i, size) - 1) * tilesize,
            y: (getRow(i, size) - 1) * tilesize,
            disabled: i === size * size
        });
    }
}

function randomizePuzzle(size, currentLobby) {
    const puzzle = puzzles[currentLobby].puzzle;

    let randomValues;
    let correctTileCount;

    do {
        randomValues = getRandomValues(size);

        let i = 0;
        for (let puzzleItem of puzzle) {
            puzzleItem.value = randomValues[i];
            puzzleItem.disabled = false;
            i++;
        }

        const emptyPuzzle = puzzle.find(item => item.value === size * size);
        emptyPuzzle.disabled = true;

        correctTileCount = countCorrectTiles(currentLobby);
    } while (correctTileCount > 3);
}

function isPuzzleValid(size, currentLobby) {
    let inversions = 0;
    const values = puzzles[currentLobby].puzzle.map(item => item.value);

    for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
            if (values[i] > values[j] && values[i] !== size * size) inversions++;
        }
    }

    return size % 2 === 1 ? inversions % 2 === 0 : inversions % 2 === 1;
}

function validateEmptyPuzzle(currentLobby) {
    return puzzles[currentLobby].puzzle.filter(item => item.disabled).length === 1;
}

function syncPuzzleToPlayers(lobbyCode) {
    const puzzle = puzzles[lobbyCode].puzzle;
    lobbies[lobbyCode].players.forEach(player => {
        player.socket.send(JSON.stringify({ action: 'updatePuzzle', puzzle }));
    });
}

function getRandomValues(size) {
    const values = Array.from({ length: size * size }, (_, i) => i + 1);
    return values.sort(() => Math.random() - 0.5);
}

function getRow(pos, size) {
    return Math.ceil(pos / size);
}

function getCol(pos, size) {
    const col = pos % size;
    return col === 0 ? size : col;
}

function countCorrectTiles(currentLobby) {
    const puzzle = puzzles[currentLobby].puzzle;
    let correctTiles = 0;
    for (let i = 0; i < puzzle.length; i++) {
        if (puzzle[i].value !== null && puzzle[i].value === puzzle[i].position) {
            correctTiles++;
        }
    }
    return correctTiles;
}

// Port für Render oder lokalen Server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));

function handleLeaveLobby(socket, lobbyCode, playerName) {
    console.log(`Player ${playerName} attempting to leave lobby ${lobbyCode}.`);

    if (!lobbies[lobbyCode]) {
        console.log(`Lobby ${lobbyCode} not found.`);
        return;
    }

    const lobby = lobbies[lobbyCode];
    const players = lobby.players;

    // Entferne den Spieler aus der Lobby
    lobby.players = players.filter(player => player.socket !== socket);

    if (lobby.players.length === 0) {
        // Wenn die Lobby leer ist, löschen
        delete lobbies[lobbyCode];
        delete puzzles[lobbyCode];
        console.log(`Lobby ${lobbyCode} deleted.`);
    } else {
        // Überprüfen, ob der Host gegangen ist
        if (lobby.host === playerName) {
            console.log(`${playerName} was the host. Selecting a new host.`);
            const newHost = lobby.players[0];
            lobby.host = newHost.name; // Der erste verbleibende Spieler wird neuer Host

            // Informiere den neuen Host
            newHost.socket.send(JSON.stringify({ action: 'newHost' }));
        }

        // Aktualisiere die Spielerliste für alle verbleibenden Spieler
        lobby.players.forEach(player => {
            player.socket.send(JSON.stringify({
                action: 'updatePlayerList',
                players: lobby.players.map(p => ({ name: p.name })),
                host: lobby.host,
            }));
        });
    }

    // Bestätigung an den Spieler, der die Lobby verlässt
    socket.send(JSON.stringify({ action: 'leftLobby' }));
}
function removePlayerFromAllLobbies(socket) {
    for (const lobbyCode in lobbies) {
        const lobby = lobbies[lobbyCode];
        lobby.players = lobby.players.filter(player => player.socket !== socket);

        if (lobby.players.length === 0) {
            delete lobbies[lobbyCode];
            delete puzzles[lobbyCode];
            console.log(`Lobby ${lobbyCode} deleted.`);
        } else {
            lobby.players.forEach(player => {
                player.socket.send(JSON.stringify({
                    action: 'updatePlayerList',
                    players: lobby.players.map(p => ({ name: p.name }))
                }));
            });
        }
    }
    socket.send(JSON.stringify({ action: 'removedFromAllLobbies' }));
}

