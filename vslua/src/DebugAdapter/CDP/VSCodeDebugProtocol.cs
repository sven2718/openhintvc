// Original work by:
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Modified by:
/*---------------------------------------------------------------------------------------------
*  Copyright (c) NEXON Korea Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/

using System;
using System.Text;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using System.Collections.Generic;
using System.Threading;

namespace VSCodeDebug
{
    public class VSCodeDebugProtocol : ICDPSender
	{
		protected const int BUFFER_SIZE = 4096;
		protected const string TWO_CRLF = "\r\n\r\n";
		protected static readonly Regex CONTENT_LENGTH_MATCHER = new Regex(@"Content-Length: (\d+)");

		protected static readonly Encoding Encoding = System.Text.Encoding.UTF8;

		private Stream _outputStream;

		private ByteBuffer _rawData;
		private int _bodyLength;

		private bool _stopRequested;

        // reverse request support (e.g., runInTerminal)
        private int _clientSeq = 1;
        private readonly object _reqLock = new object();
        private readonly Dictionary<int, ManualResetEvent> _pendingWaits = new Dictionary<int, ManualResetEvent>();
        private readonly Dictionary<int, ClientResponse> _pendingResponses = new Dictionary<int, ClientResponse>();
        private readonly Dictionary<int, Action<ClientResponse>> _pendingCallbacks = new Dictionary<int, Action<ClientResponse>>();

        private ICDPListener listener;

		public VSCodeDebugProtocol(ICDPListener listener)
        {
			_bodyLength = -1;
			_rawData = new ByteBuffer();
            this.listener = listener;
		}

		public void Loop(Stream inputStream, Stream outputStream)
		{
			_outputStream = outputStream;

			byte[] buffer = new byte[BUFFER_SIZE];

			_stopRequested = false;
			while (!_stopRequested) {
				var read = inputStream.Read(buffer, 0, buffer.Length);

				if (read == 0) {
					// end of stream
					break;
				}

				if (read > 0) {
					_rawData.Append(buffer, read);
					ProcessData();
				}
			}
		}

		public void Stop()
		{
			_stopRequested = true;
		}

		// ---- private ------------------------------------------------------------------------

		private void ProcessData()
		{
			while (true) {
				if (_bodyLength >= 0) {
					if (_rawData.Length >= _bodyLength) {
						var buf = _rawData.RemoveFirst(_bodyLength);

						_bodyLength = -1;

						Dispatch(Encoding.GetString(buf));

						continue;   // there may be more complete messages to process
					}
				}
				else {
					string s = _rawData.GetString(Encoding);
					var idx = s.IndexOf(TWO_CRLF);
					if (idx != -1) {
						Match m = CONTENT_LENGTH_MATCHER.Match(s);
						if (m.Success && m.Groups.Count == 2) {
							_bodyLength = Convert.ToInt32(m.Groups[1].ToString());

							_rawData.RemoveFirst(idx + TWO_CRLF.Length);

							continue;   // try to handle a complete message
						}
					}
				}
				break;
			}
		}

		private void Dispatch(string reqText)
		{
			dynamic envelope = JsonConvert.DeserializeObject(reqText);
			if (envelope != null && envelope.type == "request")
            {
                var request = JsonConvert.DeserializeObject<Request>(reqText);
                if (request != null && request.type == "request")
                {
                    listener.X_FromVSCode(request.command, request.seq, request.arguments, reqText);
                }
                else
                {
                    MessageBox.WTF(reqText);
                    Environment.Exit(1);
                }
            }
            else if (envelope != null && envelope.type == "response")
            {
                var response = JsonConvert.DeserializeObject<ClientResponse>(reqText);
                if (response != null)
                {
                    ManualResetEvent mre = null;
                    lock (_reqLock)
                    {
                        if (_pendingWaits.TryGetValue(response.request_seq, out mre))
                        {
                            _pendingResponses[response.request_seq] = response;
                        }
                        Action<ClientResponse> cb;
                        if (_pendingCallbacks.TryGetValue(response.request_seq, out cb))
                        {
                            _pendingCallbacks.Remove(response.request_seq);
                            if (cb != null)
                            {
                                // Dispatch callback off the IO thread
                                new System.Threading.Thread(() =>
                                {
                                    try { cb(response); } catch { }
                                }) { IsBackground = true }.Start();
                            }
                        }
                    }
                    if (mre != null)
                    {
                        try { mre.Set(); } catch { }
                    }
                }
            }
            else
            {
                MessageBox.WTF(reqText);
                Environment.Exit(1);
            }
		}

		public void SendMessage(MessageToVSCode message)
		{
			var data = ConvertToBytes(message);
			try {
				_outputStream.Write(data, 0, data.Length);
				_outputStream.Flush();
			}
			catch (Exception) {
				// ignore
			}
		}

        public void SendJSONEncodedMessage(byte[] json)
        {
            var data = PrependSizeHeader(json);
            try
            {
                _outputStream.Write(data, 0, data.Length);
                _outputStream.Flush();
            }
            catch (Exception)
            {
                // ignore
            }
        }

        private static byte[] ConvertToBytes(MessageToVSCode message)
		{
			var asJson = JsonConvert.SerializeObject(message);
			byte[] jsonBytes = Encoding.GetBytes(asJson);

            return PrependSizeHeader(jsonBytes);
		}

        private static byte[] PrependSizeHeader(byte[] jsonBytes)
        {
            string header = string.Format("Content-Length: {0}{1}", jsonBytes.Length, TWO_CRLF);
            byte[] headerBytes = Encoding.GetBytes(header);

            byte[] data = new byte[headerBytes.Length + jsonBytes.Length];
            System.Buffer.BlockCopy(headerBytes, 0, data, 0, headerBytes.Length);
            System.Buffer.BlockCopy(jsonBytes, 0, data, headerBytes.Length, jsonBytes.Length);

            return data;
        }

        public void SendOutput(string category, string data)
        {
            if (!String.IsNullOrEmpty(data))
            {
                SendMessage(new OutputEvent(category, data));
            }
        }

        // ---- Reverse request helpers ---------------------------------------------------

        class ClientRequest : MessageToVSCode
        {
            public int seq { get; set; }
            public string command { get; set; }
            public dynamic arguments { get; set; }

            public ClientRequest() : base("request") { }
        }

        class ClientResponse
        {
            public string type { get; set; } // "response"
            public bool success { get; set; }
            public int request_seq { get; set; }
            public string command { get; set; }
            public dynamic body { get; set; }
            public string message { get; set; }
        }

        private ClientResponse SendClientRequest(string command, dynamic arguments, int timeoutMs = 15000)
        {
            int mySeq;
            ManualResetEvent mre;
            lock (_reqLock)
            {
                mySeq = _clientSeq++;
                var req = new ClientRequest
                {
                    seq = mySeq,
                    command = command,
                    arguments = arguments
                };
                var data = ConvertToBytes(req);
                _outputStream.Write(data, 0, data.Length);
                _outputStream.Flush();

                mre = new ManualResetEvent(false);
                _pendingWaits[mySeq] = mre;
            }

            bool signaled = mre.WaitOne(timeoutMs);
            ClientResponse resp = null;
            lock (_reqLock)
            {
                _pendingWaits.Remove(mySeq);
                _pendingResponses.TryGetValue(mySeq, out resp);
                if (resp != null)
                {
                    _pendingResponses.Remove(mySeq);
                }
            }
            return resp;
        }

        public void RunInTerminalAsync(string kind, string title, string cwd, string[] args, Dictionary<string, string> env)
        {
            var argObj = new
            {
                kind = kind, // "integrated" | "external"
                title = title,
                cwd = cwd,
                args = args,
                env = env
            };
            // Fire and forget; VS Code will handle creating the terminal.
            // We don't block here because this runs on the IO loop thread.
            lock (_reqLock)
            {
                var req = new ClientRequest
                {
                    seq = _clientSeq++,
                    command = "runInTerminal",
                    arguments = argObj
                };
                var data = ConvertToBytes(req);
                _outputStream.Write(data, 0, data.Length);
                _outputStream.Flush();
            }
        }

        // Variant that captures the client response and invokes a callback when available.
        // Do not block the IO thread; the callback is invoked on a background thread.
        public void RunInTerminalAsync(string kind, string title, string cwd, string[] args, Dictionary<string, string> env, Action<int?, int?> onIds)
        {
            var argObj = new
            {
                kind = kind,
                title = title,
                cwd = cwd,
                args = args,
                env = env
            };
            int mySeq;
            lock (_reqLock)
            {
                mySeq = _clientSeq++;
                _pendingCallbacks[mySeq] = (resp) =>
                {
                    try
                    {
                        int? pid = null;
                        int? shellPid = null;
                        try { pid = (int?)resp.body.processId; } catch { }
                        try { shellPid = (int?)resp.body.shellProcessId; } catch { }
                        onIds?.Invoke(pid, shellPid);
                    }
                    catch { }
                };

                var req = new ClientRequest
                {
                    seq = mySeq,
                    command = "runInTerminal",
                    arguments = argObj
                };
                var data = ConvertToBytes(req);
                _outputStream.Write(data, 0, data.Length);
                _outputStream.Flush();
            }
        }
    }

    //--------------------------------------------------------------------------------------

    class ByteBuffer
	{
		private byte[] _buffer;

		public ByteBuffer() {
			_buffer = new byte[0];
		}

		public int Length {
			get { return _buffer.Length; }
		}

		public string GetString(Encoding enc)
		{
			return enc.GetString(_buffer);
		}

		public void Append(byte[] b, int length)
		{
			byte[] newBuffer = new byte[_buffer.Length + length];
			System.Buffer.BlockCopy(_buffer, 0, newBuffer, 0, _buffer.Length);
			System.Buffer.BlockCopy(b, 0, newBuffer, _buffer.Length, length);
			_buffer = newBuffer;
		}

		public byte[] RemoveFirst(int n)
		{
			byte[] b = new byte[n];
			System.Buffer.BlockCopy(_buffer, 0, b, 0, n);
			byte[] newBuffer = new byte[_buffer.Length - n];
			System.Buffer.BlockCopy(_buffer, n, newBuffer, 0, _buffer.Length - n);
			_buffer = newBuffer;
			return b;
		}
	}
}
